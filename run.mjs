// Runs every side in its own process, 3 rounds with the sides interleaved, and prints a markdown
// table with the median of the rounds.   node run.mjs [sides=v6,v7,pg] [rounds=3] [seconds=20] [concurrency=12]
import { execFileSync } from 'node:child_process';

const [sidesArg = 'v6,v7,pg', roundsArg = '3', secondsArg = '20', concArg = '12'] = process.argv.slice(2);
const sides = sidesArg.split(',');
const results = {};
for (let r = 1; r <= Number(roundsArg); r++) {
  for (const side of sides) {
    const line = execFileSync(process.execPath, ['bench.mjs', side, secondsArg, concArg], { encoding: 'utf8' }).trim().split('\n').pop();
    const res = JSON.parse(line);
    (results[side] ??= []).push(res);
    console.error(`round ${r} ${side}: ${res.qps} q/s, ${res.cpuMsPerQuery} ms CPU/query, errors ${res.errors}`);
  }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const avg = (x, k) => (x.q1[k] + x.q2[k] + x.q3[k] + x.q4[k]) / 4;
const fps = new Set(Object.values(results).flat().map((x) => x.fingerprint));
console.log(`\nfingerprints: ${fps.size === 1 ? 'all equal' : `DIFFERENT (${[...fps].join(', ')})`}\n`);
console.log('| Side | Versions | Rounds (q/s) | Median q/s | Client CPU / query | p50 / p95 / p99 ms (avg of 4 queries) | RSS |');
console.log('| :--- | :--- | :--- | ---: | ---: | :--- | ---: |');
for (const side of sides) {
  const v = results[side];
  const lat = ['p50', 'p95', 'p99'].map((k) => med(v.map((x) => avg(x, k))).toFixed(2)).join(' / ');
  console.log(`| ${side} | ${Object.entries(v[0].versions).map(([k, x]) => `${k} ${x}`).join(', ')} | ${v.map((x) => x.qps).join(' / ')} | ${med(v.map((x) => x.qps))} | ${med(v.map((x) => x.cpuMsPerQuery)).toFixed(3)} ms | ${lat} | ${med(v.map((x) => x.rssMB))} MB |`);
}
