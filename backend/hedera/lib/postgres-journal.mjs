import { randomUUID } from 'node:crypto';
import pg from 'pg';

export async function openPostgresJournal(connectionString, signerAddress) {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    options: '-c synchronous_commit=on',
  });
  // A disconnected process cannot save or release its durable signer claim.
  client.on('error', () => console.error('Merchant journal connection lost'));
  const signer = signerAddress.toLowerCase();
  const claim = randomUUID();
  try {
    await client.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS janus_merchant_signers (
        signer text PRIMARY KEY,
        claim uuid NOT NULL
      );
      CREATE TABLE IF NOT EXISTS janus_merchant_operations (
        operation_key text PRIMARY KEY,
        record jsonb NOT NULL
      );
    `);
    const result = await client.query(
      'INSERT INTO janus_merchant_signers VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [signer, claim],
    );
    if (!result.rowCount) throw new Error('Signer already locked');
  } catch (error) {
    await client.end();
    throw error;
  }

  let active;
  let closing = false;
  return {
    async withRecord(key, run) {
      if (closing || active) throw new Error('Merchant journal busy');
      active = (async () => {
        const result = await client.query(
          'SELECT record FROM janus_merchant_operations WHERE operation_key = $1',
          [key],
        );
        return run(result.rows[0]?.record, async record => {
          await client.query(`
            INSERT INTO janus_merchant_operations VALUES ($1, $2)
            ON CONFLICT (operation_key) DO UPDATE SET record = EXCLUDED.record
          `, [key, record]);
        });
      })();
      try {
        return await active;
      } finally {
        active = undefined;
      }
    },
    async close() {
      closing = true;
      await active?.catch(() => {});
      try {
        await client.query('DELETE FROM janus_merchant_signers WHERE signer = $1 AND claim = $2', [signer, claim]);
      } finally {
        await client.end();
      }
    },
  };
}
