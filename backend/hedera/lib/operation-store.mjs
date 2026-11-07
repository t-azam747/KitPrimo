import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson, decodeAuthorization } from '../../../shared/protocol.mjs';
import { syncDirectory } from '../../lib/fs-durability.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

async function withFileRecord(directory, key, run) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${key}.json`);
  const lock = await fs.open(target + '.lock', 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error('Operation busy; reconcile a crashed process before removing its lock');
    throw error;
  });
  const save = async value => {
    const temporary = target + '.tmp';
    const file = await fs.open(temporary, 'w', 0o600);
    try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); } finally { await file.close(); }
    await fs.rename(temporary, target);
    await syncDirectory(directory);
  };
  try {
    let record;
    try { record = JSON.parse(await fs.readFile(target, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return await run(record, save);
  } finally {
    await lock.close();
    await fs.unlink(target + '.lock');
  }
}

// One durable directory per merchant. Chain adapters must reconcile before any
// submission. An unknown outcome is never interpreted as an unpaid operation.
export function createOperationStore({ directory, withRecord = (key, run) => withFileRecord(directory, key, run), authenticate, reconcile, submit, produce }) {
  if (![authenticate, reconcile, submit, produce].every(fn => typeof fn === 'function')) throw new Error('Missing merchant adapter');
  return {
    async purchase({ authorization, request, principal }) {
      const identity = decodeAuthorization(authorization);
      const canonical = canonicalJson(request);
      const fingerprint = hash(canonical);
      // The request includes chain and treasury, so separate deployments never share a purchase.
      if (typeof request.chainId !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(request.treasury ?? '')) throw new Error('Missing deployment scope');
      const key = hash(canonicalJson({ chainId: request.chainId, treasury: request.treasury.toLowerCase(), taskId: identity.taskId, operationId: identity.operationId }));
      await authenticate({ identity, request, principal });
      return withRecord(key, async (record, save) => {
        if (record && record.fingerprint !== fingerprint) throw new Error('Operation fingerprint conflict');
        const observed = await reconcile({ identity, request, knownReceipt: record?.receipt });
        if (record?.status === 'ready') {
          if (observed.status !== 'paid') throw new Error('Cached settlement requires reconciliation');
          if (hash(record.result) !== record.resultHash) throw new Error('Stored result integrity failure');
          return record;
        }
        if (!['unpaid', 'paid', 'unknown'].includes(observed.status)) throw new Error('Invalid reconciliation outcome');
        if (observed.status === 'unknown') throw new Error('Payment outcome unknown');
        if (!record && observed.status === 'paid') throw new Error('Paid result unavailable; owner decision required');
        if (!record) {
          record = { version: '1', identity, fingerprint, status: 'intent' };
          await save(record);
        }
        if (observed.status === 'unpaid') {
          // Persisted submitting/paid state may represent a transaction that is
          // still propagating. A stale chain read is not permission to charge again.
          if (record.status !== 'intent') throw new Error('Payment requires reconciliation');
          record.status = 'submitting'; await save(record);
          const receipt = await submit({ identity, request, authorization });
          if (!receipt?.confirmed || typeof receipt.transaction !== 'string') throw new Error('Payment outcome unknown');
          record.receipt = receipt;
        } else record.receipt = observed.receipt;
        if (!record.receipt?.confirmed || typeof record.receipt.transaction !== 'string') throw new Error('Missing confirmed settlement');
        record.status = 'paid'; await save(record);
        // Produce must be deterministic and side-effect free: it may be rerun
        // after payment, but settlement can never be inferred from its success.
        record.result = canonicalJson(await produce({ identity, request }));
        record.resultHash = hash(record.result); record.status = 'ready';
        await save(record);
        return record;
      });
    },
  };
}
