// Runs every side in its own process, N rounds with the sides interleaved, and prints a markdown
// table with the median of the rounds. Every result line is also appended to results/<time>.jsonl.
//   node run.mjs [sides=sequelize6@pg,sequelize7@pg,pg@pg] [rounds=3] [seconds=20] [concurrency=12]
//   BENCH=dm8/bench.mjs node run.mjs ...   runs the DM8 sides (compose.dm8.yml sets it)
//   sequelize7:*@pg expands to one side per installed folder in builds/
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';

const [sidesArg = 'sequelize6@pg,sequelize7@pg,pg@pg', roundsArg = '3', secondsArg = '20', concArg = '12'] = process.argv.slice(2);
const builds = existsSync('builds') ? readdirSync('builds', { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(`builds/${d.name}/node_modules`)).map((d) => d.name) : [];
const sides = sidesArg.split(',').map((x) => x.trim()).filter(Boolean).flatMap((x) => (x.includes(':*') ? builds.map((b) => x.replace('*', b)) : [x]));
mkdirSync('results', { recursive: true });
const file = `results/${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
const results = {};
for (let r = 1; r <= Number(roundsArg); r++) {
  for (const side of sides) {
    const args = [...(side.startsWith('prisma') ? ['--import', 'tsx'] : []), process.env.BENCH || 'bench.mjs', side, secondsArg, concArg];
    let res;
    try {
      res = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim().split('\n').pop());
    } catch (e) {
      res = { side, failed: true, error: String(e.message).split('\n')[0] };
    }
    appendFileSync(file, `${JSON.stringify({ round: r, ...res })}\n`);
    if (res.failed) { console.error(`round ${r} ${side}: FAILED (${res.error})`); continue; }
    (results[side] ??= []).push(res);
    console.error(`round ${r} ${side}: ${res.qps} q/s, ${res.cpuMsPerQuery} ms CPU/query, errors ${res.errors}${res.firstError ? ` (${res.firstError})` : ''}`);
  }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const avg = (x, k) => (x.q1[k] + x.q2[k] + x.q3[k] + x.q4[k]) / 4;
const fps = new Set(Object.values(results).flat().map((x) => x.fingerprint));
console.log(`\nfingerprints: ${fps.size === 1 ? 'all equal' : `DIFFERENT (${[...fps].join(', ')})`}   raw results: ${file}\n`);
const first = sides.find((x) => results[x]);
const base = first ? med(results[first].map((x) => x.qps)) : 1;
console.log(`| Side | Versions | Rounds (q/s) | Median q/s | vs ${first} | Client CPU / query | p50 / p95 / p99 ms (avg of 4 queries) | RSS |`);
console.log('| :--- | :--- | :--- | ---: | ---: | ---: | :--- | ---: |');
for (const side of sides) {
  const v = results[side];
  if (!v) { console.log(`| ${side} | failed | | | | | | |`); continue; }
  const q = med(v.map((x) => x.qps));
  const lat = ['p50', 'p95', 'p99'].map((k) => med(v.map((x) => avg(x, k))).toFixed(2)).join(' / ');
  console.log(`| ${side} | ${Object.entries(v[0].versions).map(([k, x]) => `${k} ${x}`).join(', ')} | ${v.map((x) => x.qps).join(' / ')} | ${q} | ${(q / base).toFixed(2)}× | ${med(v.map((x) => x.cpuMsPerQuery)).toFixed(3)} ms | ${lat} | ${med(v.map((x) => x.rssMB))} MB |`);
}
