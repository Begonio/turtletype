process.env.DATABASE_SSL='false';
const { query, pool } = await import('../server/src/db/pool.js');
const credits = await import('../server/src/billing/credits.js');
const { migrate } = await import('../server/src/db/migrate.js');
await migrate();

for (let run = 0; run < 5; run++) {
  const s = Math.random().toString(36).slice(2);
  const { rows } = await query<{id:string}>(
    `INSERT INTO users (google_id,email,credits) VALUES ($1,$2,0) RETURNING id`,
    [`race-${s}`, `race-${s}@x.com`]);
  const userId = rows[0]!.id;
  await credits.grantCredits(userId, 3, 'purchase', `race:${s}`);

  const results = await Promise.allSettled(Array.from({length:10}, () =>
    credits.createJobReservingCredits({userId, docId:'d', docUrl:null, totalChars:10000, credits:1})));

  const ok = results.filter(r=>r.status==='fulfilled').length;
  const reasons = results.filter(r=>r.status==='rejected')
    .map(r=> String((r as PromiseRejectedResult).reason?.name) + ': ' + String((r as PromiseRejectedResult).reason?.message).slice(0,80));
  const counts = reasons.reduce((m,r)=>{m[r]=(m[r]??0)+1;return m;},{} as Record<string,number>);
  console.log(`run ${run}: accepted=${ok} balance=${await credits.balanceOf(userId)}`, counts);
}
await pool.end();
