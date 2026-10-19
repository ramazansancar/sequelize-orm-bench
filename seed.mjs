// Creates the 7 tables on one database and fills them with the same deterministic data
// (lib/data.mjs), plus the indexes the queries use.
//   node seed.mjs [--target pg|crdb|yb|ch] [--if-needed]      (default pg)
// --if-needed skips the target when it already holds the full data set (used by the compose files).
import pg from 'pg';
import { DB } from './lib/config.mjs';
import { TABLES, INDEXES, generate } from './lib/data.mjs';

const target = process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : 'pg';
const q = (s) => `"${s}"`;
const t0 = Date.now();
if (process.argv.includes('--if-needed')) {
  const sql = 'SELECT count(*) AS n FROM "Messages"';
  let n = 0;
  try {
    // close the connection on the "no tables yet" path too, or the process never exits
    if (target === 'ch') { const { createClient } = await import('@clickhouse/client'); const ch = createClient(DB.ch); try { n = Number((await (await ch.query({ query: sql, format: 'JSONEachRow' })).json())[0].n); } finally { await ch.close(); } }
    else { const c = new pg.Client(DB[target]); await c.connect(); try { n = Number((await c.query(sql)).rows[0].n); } finally { await c.end(); } }
  } catch { /* no tables yet */ }
  if (n === 500000) { console.log(`${target}: already seeded`); process.exit(0); }
}
const data = generate();

if (target === 'ch') {
  const { createClient } = await import('@clickhouse/client');
  const ch = createClient(DB.ch);
  const notNull = new Set(['id', 'userId', 'roleId', 'itemId', 'otherId', 'isActive', 'isPublic', 'isRead', 'language', 'status', 'createdAt']);
  const chType = (t, c) => {
    const base = t === 'uuid' ? 'UUID' : t === 'boolean' ? 'Bool' : t === 'int' ? 'Int32' : t === 'timestamptz' ? "DateTime64(3, 'UTC')" : 'String';
    return notNull.has(c) ? base : `Nullable(${base})`;
  };
  // MergeTree sorting keys picked for the four queries
  const ORDER = { Users: ['id'], Roles: ['id'], UserRoles: ['userId', 'roleId'], Items: ['id'], ItemTranslations: ['itemId', 'language'], Messages: ['userId', 'createdAt'], Links: ['userId', 'otherId'] };
  for (const [table, cols] of TABLES) {
    await ch.command({ query: `DROP TABLE IF EXISTS ${q(table)}` });
    await ch.command({ query: `CREATE TABLE ${q(table)} (${cols.map(([c, t]) => `${q(c)} ${chType(t, c)}`).join(', ')}) ENGINE = MergeTree ORDER BY (${ORDER[table].map(q).join(', ')})` });
    const values = data[table].map((r) => Object.fromEntries(cols.map(([c], i) => [c, r[i] instanceof Date ? r[i].toISOString().replace('T', ' ').replace('Z', '') : r[i]])));
    for (let i = 0; i < values.length; i += 50000) await ch.insert({ table, values: values.slice(i, i + 50000), format: 'JSONEachRow' });
    console.log(`${table}: ${values.length}`);
  }
  await ch.command({ query: 'OPTIMIZE TABLE "Messages" FINAL' });
  await ch.close();
} else {
  const c = new pg.Client(DB[target]);
  await c.connect();
  for (const [table] of [...TABLES].reverse()) await c.query(`DROP TABLE IF EXISTS ${q(table)}`);
  for (const [table, cols] of TABLES) {
    await c.query(`CREATE TABLE ${q(table)} (${cols.map(([n, t]) => `${q(n)} ${t}${n === 'id' ? ' PRIMARY KEY' : ''}`).join(', ')})`);
    const rows = data[table];
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000); const params = [];
      const tuples = chunk.map((r) => `(${r.map((v) => { params.push(v); return `$${params.length}`; }).join(', ')})`);
      await c.query(`INSERT INTO ${q(table)} (${cols.map(([n]) => q(n)).join(', ')}) VALUES ${tuples.join(', ')}`, params);
    }
    console.log(`${table}: ${rows.length}`);
  }
  for (const [table, cols, unique] of INDEXES) {
    await c.query(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX ON ${q(table)} (${cols.map((x) => x.replace(/^(\w+)/, '"$1"')).join(', ')})`);
  }
  if (target === 'pg') await c.query('VACUUM ANALYZE');
  else for (const [table] of TABLES) await c.query(`ANALYZE ${q(table)}`);
  await c.end();
}
console.log(`seeded ${target} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
