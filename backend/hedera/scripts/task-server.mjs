import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http as rpc } from 'viem';
import { acquireSignerLock } from '../lib/signer-lock.mjs';
import { privateKeyToAccount } from 'viem/accounts';
import { createTaskMerchant, requestHash, taskMerchantHandler } from '../lib/task-merchant.mjs';

async function main() {
  const env = new URL('../../.env.hedera', import.meta.url);
  if (fs.existsSync(env)) process.loadEnvFile(env);
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT ?? '4023');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const directory = process.env.JANUS_MERCHANT_STATE || fileURLToPath(new URL('../../.merchant-state/', import.meta.url));
  const databaseUrl = process.env.JANUS_MERCHANT_DATABASE_URL;
  const accessToken = process.env.JANUS_MERCHANT_ACCESS_TOKEN;
  if (process.env.RENDER === 'true' && ((!databaseUrl && !process.env.JANUS_MERCHANT_STATE) || !accessToken || accessToken.length < 32)) {
    throw new Error('Render requires Postgres or a persistent merchant state path and an access token of at least 32 characters');
  }
  const authorization = accessToken ? Buffer.from('Bearer ' + accessToken) : null;
  const network = JSON.parse(fs.readFileSync(new URL('../../../shared/network.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(new URL('../../../shared/deployments/hedera-testnet.json', import.meta.url), 'utf8'));
  if (!/^0x[0-9a-fA-F]{64}$/.test(process.env.HEDERA_MERCHANT_PRIVATE_KEY ?? '')) throw new Error('Dedicated testnet merchant key required in environment');
  let merchantAccount;
  try { merchantAccount = privateKeyToAccount(process.env.HEDERA_MERCHANT_PRIVATE_KEY); }
  catch { throw new Error('Invalid dedicated testnet merchant key'); }
  const chain = defineChain({ ...network, id: network.chainId }), transport = rpc(process.env.HEDERA_RPC_URL || network.rpcUrls.default.http[0]);
  const publicClient = createPublicClient({ chain, transport, cacheTime: 0 });
  const proof = JSON.parse(fs.readFileSync(new URL('../../../contracts/phase1/evidence/live-proof.json', import.meta.url), 'utf8'));
  const deploymentReceipt = await publicClient.getTransactionReceipt({ hash: proof.deploymentHash });
  let journal;
  const merchant = await createTaskMerchant({
    directory,
    withRecord: databaseUrl ? (key, run) => journal.withRecord(key, run) : undefined,
    publicClient,
    fromBlock: deploymentReceipt.blockNumber,
    walletClient: createWalletClient({ chain, transport, account: merchantAccount }),
    manifest,
    produce: async ({ request }) => ({ schemaVersion: '1', requestHash: requestHash(request), dataset: request.body }),
  });
  let releaseSigner;
  if (databaseUrl) {
    const { openPostgresJournal } = await import('../lib/postgres-journal.mjs');
    journal = await openPostgresJournal(databaseUrl, merchantAccount.address);
    releaseSigner = journal.close;
  } else {
    releaseSigner = acquireSignerLock(directory, merchantAccount.address);
    process.once('exit', releaseSigner);
  }
  const handleMerchant = taskMerchantHandler(merchant);
  const server = http.createServer({ requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 16384 }, (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end('{"status":"ok"}');
    }
    if (authorization) {
      const supplied = Buffer.from(req.headers.authorization || '');
      if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
        return res.end('{"error":"unauthorized"}');
      }
    }
    return handleMerchant(req, res);
  });
  let shuttingDown = false;
  async function shutdown(exitCode) {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await releaseSigner();
    } catch {
      console.error('Merchant journal shutdown failed; reconcile the signer claim before restarting');
      exitCode = 1;
    }
    process.exit(exitCode);
  }
  server.once('error', () => {
    console.error('Task merchant listener failed');
    void shutdown(1);
  });
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  server.keepAliveTimeout = 5000;
  server.listen(port, host, () => console.log('Hedera testnet task merchant listening on %s:%d', host, port));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => { void shutdown(0); }));
}
main().catch(() => { console.error('Task merchant startup failed; run npm run task:preflight --prefix backend for setup diagnostics'); process.exitCode = 1; });
