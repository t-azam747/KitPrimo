import { transactionPolicy } from './transaction-policy.mjs';
import { keccak256, stringToHex, verifyMessage, parseEventLogs } from 'viem';
import { canonicalJson, baseUnits, decodeAuthorization } from '../../../shared/protocol.mjs';
import { taskTreasuryAbi as abi } from './treasury.mjs';
import { validateTreasury } from '../../../contracts/phase1/lib/recovery.mjs';
import { createOperationStore } from './operation-store.mjs';

export const requestHash = request => keccak256(stringToHex(canonicalJson(request)));
export const accessMessage = (authorization, request, expiresAt) => canonicalJson({ domain: 'janus-merchant-access/1', authorization, requestHash: requestHash(request), expiresAt });
export const quoteMessage = quote => canonicalJson({ ...quote, domain: 'janus-merchant-quote/1' });

export async function createTaskMerchant({ directory, withRecord, publicClient, walletClient, manifest, produce, fromBlock = 0n, price = '20000', route = '/dataset', confirmations = 2, logPageSize = 1000n }) {
  await validateTreasury(publicClient, manifest);
  if (!Number.isSafeInteger(confirmations) || confirmations < 1 || logPageSize < 1n || logPageSize > 10000n) throw new Error('Invalid settlement policy');
  const merchant = walletClient.account.address;
  const read = (name, args) => publicClient.readContract({ address: manifest.treasury, abi, functionName: name, args });
  const validate = async ({ identity, request }) => {
    if (request.chainId !== String(manifest.chainId) || request.treasury.toLowerCase() !== manifest.treasury.toLowerCase()
      || request.token?.toLowerCase() !== manifest.token.toLowerCase() || request.merchant?.toLowerCase() !== merchant.toLowerCase()
      || request.route !== route || request.amount !== price) throw new Error('Quote scope mismatch');
    if (baseUnits(request.amount) === 0n) throw new Error('Invalid price');
    const task = await read('tasks', [identity.taskId]);
    if (!task[0] || task[7].toLowerCase() !== merchant.toLowerCase() || baseUnits(request.amount) > task[5]) throw new Error('Task policy mismatch');
    return task;
  };
  const reconcile = async ({ identity, request, knownReceipt }) => {
    await validate({ identity, request });
    const op = await read('getOperation', [identity.taskId, identity.operationId]);
    if (op.amount !== baseUnits(request.amount) || op.requestHash !== requestHash(request)) throw new Error('Reservation fingerprint mismatch');
    if (Number(op.status) === 2) {
      let log;
      if (knownReceipt?.transaction) {
        const receipt = await publicClient.getTransactionReceipt({ hash: knownReceipt.transaction });
        if (receipt.status !== 'success') return { status: 'unknown' };
        log = parseEventLogs({ abi, logs: receipt.logs, eventName: 'Paid' }).find(item => item.address.toLowerCase() === manifest.treasury.toLowerCase() && item.args.taskId === identity.taskId && item.args.operationId === identity.operationId && item.args.amount === op.amount && item.args.attempt === op.attempt);
      } else {
        const latest = await publicClient.getBlockNumber();
        for (let start = BigInt(fromBlock); start <= latest; start += logPageSize) {
          const end = start + logPageSize - 1n;
          const logs = await publicClient.getLogs({ address: manifest.treasury, event: abi.find(item => item.type === 'event' && item.name === 'Paid'),
            args: { taskId: identity.taskId, operationId: identity.operationId }, fromBlock: start, toBlock: end < latest ? end : latest });
          log = logs.find(item => item.args.amount === op.amount && item.args.attempt === op.attempt);
          if (log) break;
        }
      }
      if (!log || (await publicClient.getBlockNumber()) < log.blockNumber + BigInt(confirmations - 1)) return { status: 'unknown' };
      return { status: 'paid', receipt: { confirmed: true, transaction: log.transactionHash } };
    }
    if (Number(op.status) !== 1 || op.attempt !== BigInt(identity.attempt)) throw new Error('Reservation unavailable');
    if ((await publicClient.getBlock()).timestamp >= op.deadline) throw new Error('Reservation expired');
    return { status: 'unpaid' };
  };
  let settlementQueue = Promise.resolve();
  const serialize = action => { const pending = settlementQueue.then(action); settlementQueue = pending.catch(() => {}); return pending; };
  const store = createOperationStore({ directory, withRecord, produce, reconcile,
    authenticate: async ({ identity, request, principal }) => {
      const task = await validate({ identity, request });
      const expiry = baseUnits(principal?.expiresAt);
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (expiry <= now || expiry > now + 300n) throw new Error('Access expired');
      const owner = manifest.owner.toLowerCase(), address = principal.address?.toLowerCase();
      if (address !== owner && (task[9] || address !== task[6].toLowerCase())) throw new Error('Unauthorized task access');
      if (!await verifyMessage({ address: principal.address, message: accessMessage(encodeIdentity(identity), request, principal.expiresAt), signature: principal.signature })) throw new Error('Invalid access signature');
    },
    submit: ({ identity, request, authorization }) => serialize(async () => {
      const observed = await reconcile({ identity, request });
      if (observed.status === 'paid') return observed.receipt;
      if (observed.status !== 'unpaid') throw new Error('Payment outcome unknown');
      if (await walletClient.getChainId() !== manifest.chainId) throw new Error('Wallet chain mismatch');
      const transaction = await walletClient.writeContract({ ...await transactionPolicy(publicClient, manifest.chainId), address: manifest.treasury, abi, functionName: 'executeTransfer',
        args: [manifest.treasury, manifest.token, merchant, baseUnits(request.amount), authorization] });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: transaction, confirmations });
      const paid = parseEventLogs({ abi, logs: receipt.logs, eventName: 'Paid' }).find(log => log.address.toLowerCase() === manifest.treasury.toLowerCase()
        && log.args.taskId === identity.taskId && log.args.operationId === identity.operationId && log.args.amount === baseUnits(request.amount));
      if (receipt.status !== 'success' || !paid) throw new Error('Settlement not confirmed');
      return { confirmed: true, transaction };
    }),
  });
  return { purchase: store.purchase,
    async quote({ authorization, request }) {
      const identity = decodeAuthorization(authorization);
      await validate({ identity, request });
      const quote = { authorization, requestHash: requestHash(request), expiresAt: String(Math.floor(Date.now() / 1000) + 120), merchant };
      return { ...quote, signature: await walletClient.signMessage({ message: quoteMessage(quote) }) };
    },
    async buy({ quote, authorization, request, principal }) {
      const { signature, ...signed } = quote;
      if (quote.authorization !== authorization || quote.requestHash !== requestHash(request) || quote.merchant.toLowerCase() !== merchant.toLowerCase()
        || baseUnits(quote.expiresAt) <= BigInt(Math.floor(Date.now() / 1000))
        || !await verifyMessage({ address: merchant, message: quoteMessage(signed), signature })) throw new Error('Invalid merchant quote');
      return store.purchase({ authorization, request, principal });
    },
  };
}
import { encodeAuthorization as encodeIdentityParts } from '../../../shared/protocol.mjs';
const encodeIdentity = identity => encodeIdentityParts(identity.taskId, identity.operationId, identity.attempt);

export function taskMerchantHandler(merchant) {
  return async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      if (req.method !== 'POST' || !['/quote', '/purchase'].includes(req.url)) return json(404, { error: 'not_found' });
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) return json(413, { error: 'request_too_large' }); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return json(200, await (req.url === '/quote' ? merchant.quote(input) : merchant.buy(input)));
    } catch { return json(409, { error: 'request_rejected_or_reconciliation_required' }); }
  };
}
