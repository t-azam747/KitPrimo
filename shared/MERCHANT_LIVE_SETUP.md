# Merchant live verification setup

Status: credentials have been restored and backend preflight has passed against the pinned treasury. The frontend public verification key was retrieved from Privy and installed locally; authentication tests/build passed. RPC access is intermittent, so fresh task-aware payment and production qualification are not complete. The bounded live purchase is authorized for at most 20,000 test-USDC base units (0.02), plus test HBAR gas; no live transaction has been submitted in this hardening phase.

## Required local configuration

An ignored, owner-readable `backend/.env.hedera` template is ready. Restore the existing dedicated ECDSA private keys as 0x-prefixed 32-byte hex values under `HEDERA_OWNER_PRIVATE_KEY`, `HEDERA_WORKER_PRIVATE_KEY`, and `HEDERA_MERCHANT_PRIVATE_KEY`. Never put them in chat, source, reports or command arguments. The owner must control the pinned treasury (`0x99a5aa34c43639266FB7E1bCe6a5f8130a20ad5c`). Generating a different owner key does not transfer ownership of this contract.

Set `HEDERA_RPC_URL` to a working Hedera testnet JSON-RPC service (chain 296) supporting transaction receipts, logs and HTS contract calls. The configured public Hashio endpoint timed out during read-only preflight. RPC URLs/credentials remain only in the ignored environment file.

The owner, worker and merchant need test HBAR for their transactions. The treasury needs at least 20,000 unallocated test-USDC base units for a fresh task. Its existing historical tasks have a smaller per-operation limit than the reference 20,000-unit price; a separately bounded new task must be allocated by its owner before this purchase. Existing tasks/policies must not be changed or silently reused for a larger payment. Actual balances and policy will be checked after RPC access is restored.

Run from the repository root:

```sh
npm run task:preflight --prefix backend
```

This is read-only. It prints public identities and missing setup, never keys, and exits nonzero while checks fail. Reply that setup is ready after restoring the file/provider. Payment authorization already exists; it does not need to be requested again within the stated bound. The next live run must save exact reservation/payment transactions and token-accounting evidence and verify repeat retrieval without another debit. A successful preflight alone is not payment evidence.

## Hardening implemented

- Default two-block confirmation depth; an observation below policy stays unknown. Local instant-chain fixtures explicitly use one confirmation. This does not establish a production reorg/finality guarantee.
- Cached receipts are reconciled directly by transaction hash. Missing receipts are discovered through bounded log pages; server bootstrap starts at the actual deployment receipt's block instead of genesis.
- Hedera legacy transactions have a fixed 500,000 gas ceiling and maximum gas-price product of 2 test HBAR per transaction. Other chains remain restricted to local fixtures through manifest validation.
- SDK merchant endpoints require HTTPS except exact loopback hosts, and reject embedded URL credentials.
- HTTP header/body/time/connection limits, plus one signer-process lock per merchant key/state directory. A hard-killed signer leaves a fail-closed lock; reconcile chain/nonces and stop writers before manual removal. Multi-host key coordination remains outside this filesystem implementation.
- Existing signature, fixed-price, task cap, epoch, result-integrity and unknown-payment checks remain in force. No missing result is turned into an invented refund or an automatic second purchase.

Public hosting, an authenticated/rate-limited TLS gateway, storage backups/restore rehearsal, operational key custody and independent financial-code review remain release work. This custom signed HTTP adapter does not claim general x402 interoperability or mainnet readiness. Do not relabel a local passing suite as production certification.

## Verified live result

The bounded live check passed on 6 November 2026. The allocation was reconciled against latest/pending owner nonces, signed with a fixed nonce, and its raw transaction/hash journaled before one broadcast. Its immutable task ID prevents another allocation. Subsequent uncertain broadcasts reconcile the saved hash rather than generating another transaction.

The treasury debit and merchant credit were exactly 20,000 USDC base units. Paid-result replay returned the original receipt and artifact hash with no additional debit. Public evidence is in `backend/hedera/evidence/task-aware-live-proof.json`; signed transaction bytes remain only in ignored private state. The completed-run guard reports the saved proof without network calls or new spending. The public RPC can still be intermittent; this is bounded testnet verification, not a production availability guarantee or native consensus child-record certification.

## Render testnet merchant

The repository root `render.yaml` defines one paid Node service with a persistent disk and manual deploys. Connect the repository in Render as a Blueprint and set the dedicated `HEDERA_MERCHANT_PRIVATE_KEY` and `HEDERA_RPC_URL` in Render. Configure merchant callers to send `Authorization: Bearer <JANUS_MERCHANT_ACCESS_TOKEN>` using the generated service secret. `GET /health` is public and serves only startup readiness. The Compose dashboard still uses its local merchant and chain.

Stop any other process using the same signer before starting the hosted merchant. Preserve its existing merchant state under the configured disk path if migrating an active deployment. After deployment, verify readiness and check that a bounded testnet purchase can be replayed after a restart without an additional debit.
