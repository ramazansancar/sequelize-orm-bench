// Creates the 7 tables on DM8 (schema SYSDBA) with the same rows as ../seed.mjs, the same
// indexes, then gathers optimizer stats.   node dm8/seed.mjs [--if-needed]
// Types: uuid -> CHAR(36) (DM8 has no uuid type), boolean -> BIT, timestamptz -> TIMESTAMP WITH TIME
// ZONE, varchar(n) -> VARCHAR(n CHAR) (plain VARCHAR(n) counts bytes on DM8), text -> VARCHAR(320 CHAR).
import dmdb from 'dmdb';
import { TABLES, INDEXES, generate } from '../lib/data.mjs';
import { DM8 } from './config.mjs';

const q = (s) => `"${s}"`;
const t0 = Date.now();
// the container reports healthy once the port is open; the instance may need a few more seconds
let dm;
for (let i = 1; !dm; i++) {
  try { dm = await dmdb.getConnection(`${DM8.url}?autoCommit=false`); } catch (e) { if (i === 60) throw e; await new Promise((r) => setTimeout(r, 2000)); }
}
if (process.argv.includes('--if-needed')) {
  try {
    const n = (await dm.execute('SELECT COUNT(*) AS "n" FROM "Messages"', [], { outFormat: dmdb.OUT_FORMAT_OBJECT })).rows[0].n;
    if (Number(n) === 500000) { console.log('dm8: already seeded'); await dm.close(); process.exit(0); }
  } catch { /* no tables yet */ }
}
const dmType = (t) => (t === 'uuid' ? 'CHAR(36)' : t === 'boolean' ? 'BIT' : t === 'int' ? 'INT' : t === 'timestamptz' ? 'TIMESTAMP WITH TIME ZONE' : t === 'text' ? 'VARCHAR(320 CHAR)' : t.replace(/\((\d+)\)/, '($1 CHAR)'));
const data = generate();
for (const [table, cols] of TABLES) {
  try { await dm.execute(`DROP TABLE ${q(table)}`); } catch { /* first run */ }
  await dm.execute(`CREATE TABLE ${q(table)} (${cols.map(([c, t]) => `${q(c)} ${dmType(t)}${c === 'id' ? ' NOT NULL' : ''}`).join(', ')}, PRIMARY KEY ("id"))`);
  const rows = data[table].map((r) => r.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)));
  const sql = `INSERT INTO ${q(table)} (${cols.map(([c]) => q(c)).join(', ')}) VALUES (${cols.map((_, i) => `:${i + 1}`).join(', ')})`;
  for (let i = 0; i < rows.length; i += 2000) await dm.executeMany(sql, rows.slice(i, i + 2000));
  await dm.commit();
  console.log(`${table}: ${rows.length}`);
}
for (const [table, cols, unique] of INDEXES) {
  await dm.execute(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${q(`ix_${table}_${cols.join('_').replace(/\W+/g, '')}`)} ON ${q(table)} (${cols.map((x) => x.replace(/^(\w+)/, '"$1"')).join(', ')})`);
}
await dm.commit();
for (const [table] of TABLES) await dm.execute(`CALL DBMS_STATS.GATHER_TABLE_STATS('SYSDBA', '${table}', null, 100, FALSE, 'FOR ALL COLUMNS SIZE AUTO')`);
await dm.commit();
await dm.close();
console.log(`seeded dm8 in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
