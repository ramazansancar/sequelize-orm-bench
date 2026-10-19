// Runs one side: fingerprint first (all sides must return the same rows), then SECONDS of a
// 35/25/25/15 query mix with CONC queries in flight. Prints one JSON line.
import { createHash } from 'node:crypto';
import pg from 'pg';
import { DB } from './config.mjs';

const MIX = [[35, 'q1'], [25, 'q2'], [25, 'q3'], [15, 'q4']];
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 100) / 100; };

export async function runSide(name, s, { seconds, conc, showSql, sqlLog }) {
  // the user ids come from PostgreSQL for every side (the data is identical everywhere)
  const c = new pg.Client(DB.pg); await c.connect();
  const ids = (await c.query(`SELECT "userId" AS id FROM "Messages" GROUP BY "userId" ORDER BY "userId" LIMIT 500`)).rows.map((x) => x.id);
  await c.end();
  const h = createHash('sha1');
  for (const id of ids.slice(0, 30)) h.update(JSON.stringify([await s.q1(id), await s.q3(id), await s.q4(id)]));
  h.update(JSON.stringify(await s.q2()));
  const fingerprint = h.digest('hex').slice(0, 16);
  if (showSql) {
    for (const l of sqlLog.slice(0, 4)) console.log(String(l).slice(0, 800));
    console.log(JSON.stringify({ side: name, versions: s.versions, fingerprint }));
    await s.close(); return;
  }
  const lat = { q1: [], q2: [], q3: [], q4: [] };
  const pick = () => { let r = Math.random() * 100; for (const [w, q] of MIX) { if ((r -= w) <= 0) return q; } return 'q1'; };
  let done = 0; let errors = 0; let firstError = null;
  const end = Date.now() + seconds * 1000;
  const worker = async () => {
    while (Date.now() < end) {
      const q = pick(); const id = ids[(Math.random() * ids.length) | 0]; const t = process.hrtime.bigint();
      try { await s[q](id); lat[q].push(Number(process.hrtime.bigint() - t) / 1e6); done += 1; } catch (e) { errors += 1; firstError ??= e.message; }
    }
  };
  const cpu0 = process.cpuUsage(); const t0 = Date.now();
  await Promise.all(Array.from({ length: conc }, worker));
  const wall = (Date.now() - t0) / 1000; const cpu = process.cpuUsage(cpu0);
  await s.close();
  const out = { side: name, versions: s.versions, node: process.version, qps: Math.round(done / wall), errors, firstError, cpuMsPerQuery: Math.round(((cpu.user + cpu.system) / 1000 / done) * 1000) / 1000, rssMB: Math.round(process.memoryUsage().rss / 1e6), fingerprint };
  for (const [k, v] of Object.entries(lat)) out[k] = { p50: pct(v, 50), p95: pct(v, 95), p99: pct(v, 99) };
  console.log(JSON.stringify(out));
}
