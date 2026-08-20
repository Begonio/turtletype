process.env.DATABASE_SSL='false';
const { query, withTransaction } = await import('../server/src/db/pool.js');
const suffix = Math.random().toString(36).slice(2);
const { rows } = await query<{id:string}>(
  `INSERT INTO users (google_id, email, credits) VALUES ($1,$2,0) RETURNING id`,
  [`dbg-${suffix}`, `dbg-${suffix}@x.com`]);
const userId = rows[0]!.id;
await withTransaction(async (client) => {
  const locked = await client.query('SELECT credits FROM users WHERE id = $1 FOR UPDATE', [userId]);
  console.log('locked rows:', locked.rows);
  const inserted = await client.query(
    `INSERT INTO credit_ledger (user_id, delta, balance_after, reason, reference)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (reason, reference) WHERE reference IS NOT NULL DO NOTHING
     RETURNING id`,
    [userId, 5, 5, 'purchase', 'dbgref-'+suffix]);
  console.log('inserted rowCount:', inserted.rowCount, 'rows:', inserted.rows);
});
process.exit(0);
