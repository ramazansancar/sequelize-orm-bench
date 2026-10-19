// One side, one process:  node bench.mjs <side> [seconds=20] [concurrency=12] [--sql]
// A side is <library>@<database>, e.g. sequelize6@pg, sequelize7@pg, pg@pg, kysely@crdb
// (the list is in the README). Runs a 35/25/25/15 mix of the four read queries for N seconds with
// C queries in flight and prints one JSON line: q/s, client CPU per query, p50/p95/p99 per query,
// RSS, versions and a fingerprint of the results (all sides must print the same fingerprint).
// --sql prints the SQL of the first queries and the fingerprint instead.
// Prisma sides need tsx:  node --import tsx bench.mjs prisma@pg   (run.mjs adds it)
import { makeSide } from './lib/sides.mjs';
import { runSide } from './lib/harness.mjs';

const [side, secondsArg, concArg, flag] = process.argv.slice(2);
if (!side) { console.error('usage: node bench.mjs <library>@<database> [seconds] [concurrency] [--sql]'); process.exit(2); }
const conc = Number(concArg) || 12;
const sqlLog = [];
const s = await makeSide(side, conc, flag === '--sql' ? sqlLog : null);
await runSide(side, s, { seconds: Number(secondsArg) || 20, conc, showSql: flag === '--sql', sqlLog });
process.exit(0);
