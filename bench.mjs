// One side, one process:  node bench.mjs <v6|v7|pg> [seconds=20] [concurrency=12] [--sql]
// Runs a 35/25/25/15 mix of four read queries for N seconds with C queries in flight and prints
// one JSON line: q/s, client CPU per query, p50/p95/p99 per query, RSS, versions and a fingerprint
// of the results (all sides must print the same fingerprint).
// Connection: PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE (defaults match docker-compose.yml).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { defineModels } from './models.mjs';

const require = createRequire(import.meta.url);
const [side, secondsArg, concArg, flag] = process.argv.slice(2);
const SECONDS = Number(secondsArg) || 20;
const CONC = Number(concArg) || 12;
const SHOW_SQL = flag === '--sql';
const conn = {
  host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5440),
  user: process.env.PGUSER || 'bench', password: process.env.PGPASSWORD || 'bench', database: process.env.PGDATABASE || 'bench',
};
const MIX = [[35, 'q1'], [25, 'q2'], [25, 'q3'], [15, 'q4']];
const sqlLog = [];
const pkgVersion = (name) => JSON.parse(readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url), 'utf8')).version;

function sequelizeQueries(m, Op) {
  const { User, Role, Item, ItemTranslation, Message, Link } = m;
  const logging = SHOW_SQL ? (s) => sqlLog.push(s) : false;
  return {
    q1: async (id) => {
      const u = await User.findByPk(id, {
        logging,
        attributes: ['id', 'email', 'username', 'firstName', 'lastName', 'organizationId', 'preferredLanguage'],
        include: [{ model: Role, as: 'roles', attributes: ['id', 'key', 'name', 'priority'], through: { attributes: [] } }],
      });
      return u ? { id: u.id, roles: u.roles.map((r) => r.key).sort() } : null;
    },
    q2: async () => (await Item.findAll({
      logging,
      attributes: ['id', 'type', 'isPublic', 'displayOrder', 'createdAt'],
      where: { isActive: true, isPublic: true },
      include: [{ model: ItemTranslation, as: 'translations', attributes: ['name'], where: { language: 'en' }, required: false }],
      order: [['displayOrder', 'ASC NULLS LAST'], ['createdAt', 'DESC']],
      limit: 40,
    })).map((i) => i.id),
    q3: async (id) => (await Message.findAll({
      logging, attributes: ['id', 'type', 'title', 'isRead', 'createdAt'], where: { userId: id }, order: [['createdAt', 'DESC']], limit: 20,
    })).map((x) => x.id),
    q4: async (id) => Number(await Link.count({ logging, where: { status: 'accepted', [Op.or]: [{ userId: id }, { otherId: id }] } })),
  };
}

async function makeSide() {
  if (side === 'v6') {
    const S = require('sequelize6');
    const sequelize = new S.Sequelize(conn.database, conn.user, conn.password, { host: conn.host, port: conn.port, dialect: 'postgres', logging: false, pool: { max: CONC, min: Math.min(2, CONC) } });
    const m = defineModels(sequelize, { DataTypes: S.DataTypes, Op: S.Op, literal: S.literal });
    return { versions: { sequelize: pkgVersion('sequelize6') }, ...sequelizeQueries(m, S.Op), close: () => sequelize.close() };
  }
  if (side === 'v7') {
    const S = await import('@sequelize/core');
    const { PostgresDialect } = await import('@sequelize/postgres');
    const sequelize = new S.Sequelize({ dialect: PostgresDialect, ...conn, logging: false, pool: { max: CONC, min: Math.min(2, CONC) } });
    const m = defineModels(sequelize, { DataTypes: S.DataTypes, Op: S.Op, literal: S.literal });
    return { versions: { '@sequelize/core': pkgVersion('@sequelize/core') }, ...sequelizeQueries(m, S.Op), close: () => sequelize.close() };
  }
  if (side === 'pg') {
    const pool = new pg.Pool({ ...conn, max: CONC });
    const q = async (sql, p) => { if (SHOW_SQL) sqlLog.push(sql); return (await pool.query(sql, p)).rows; };
    return {
      versions: { pg: pkgVersion('pg') },
      q1: async (id) => {
        const rows = await q(`SELECT u.id, r.key FROM "Users" u LEFT JOIN "UserRoles" ur ON ur."userId" = u.id AND ur."isActive" = true AND (ur."expiresAt" IS NULL OR ur."expiresAt" > NOW()) LEFT JOIN "Roles" r ON r.id = ur."roleId" WHERE u.id = $1`, [id]);
        return rows.length ? { id: rows[0].id, roles: rows.filter((r) => r.key).map((r) => r.key).sort() } : null;
      },
      q2: async () => (await q(`SELECT i.id FROM "Items" i LEFT JOIN "ItemTranslations" t ON t."itemId" = i.id AND t.language = 'en' WHERE i."isActive" = true AND i."isPublic" = true ORDER BY i."displayOrder" ASC NULLS LAST, i."createdAt" DESC LIMIT 40`)).map((r) => r.id),
      q3: async (id) => (await q(`SELECT id FROM "Messages" WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 20`, [id])).map((r) => r.id),
      q4: async (id) => (await q(`SELECT count(*)::int AS n FROM "Links" WHERE status = 'accepted' AND ("userId" = $1 OR "otherId" = $1)`, [id]))[0].n,
      close: () => pool.end(),
    };
  }
  throw new Error(`unknown side ${side} (v6 | v7 | pg)`);
}

const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 100) / 100; };
const s = await makeSide();
const ids = await (async () => { const c = new pg.Client(conn); await c.connect(); const r = await c.query(`SELECT "userId" AS id FROM "Messages" GROUP BY "userId" ORDER BY "userId" LIMIT 500`); await c.end(); return r.rows.map((x) => x.id); })();
const h = createHash('sha1');
for (const id of ids.slice(0, 30)) h.update(JSON.stringify([await s.q1(id), await s.q3(id), await s.q4(id)]));
h.update(JSON.stringify(await s.q2()));
const fingerprint = h.digest('hex').slice(0, 16);
if (SHOW_SQL) { for (const l of sqlLog.slice(0, 4)) console.log(l); console.log(JSON.stringify({ side, fingerprint })); await s.close(); process.exit(0); }
const lat = { q1: [], q2: [], q3: [], q4: [] };
const pick = () => { let r = Math.random() * 100; for (const [w, q] of MIX) { if ((r -= w) <= 0) return q; } return 'q1'; };
let done = 0; let errors = 0;
const end = Date.now() + SECONDS * 1000;
const worker = async () => { while (Date.now() < end) { const q = pick(); const id = ids[(Math.random() * ids.length) | 0]; const t = process.hrtime.bigint(); try { await s[q](id); lat[q].push(Number(process.hrtime.bigint() - t) / 1e6); done += 1; } catch { errors += 1; } } };
const cpu0 = process.cpuUsage(); const t0 = Date.now();
await Promise.all(Array.from({ length: CONC }, worker));
const wall = (Date.now() - t0) / 1000; const cpu = process.cpuUsage(cpu0);
await s.close();
const out = { side, versions: s.versions, node: process.version, qps: Math.round(done / wall), errors, cpuMsPerQuery: Math.round(((cpu.user + cpu.system) / 1000 / done) * 1000) / 1000, rssMB: Math.round(process.memoryUsage().rss / 1e6), fingerprint };
for (const [k, v] of Object.entries(lat)) out[k] = { p50: pct(v, 50), p95: pct(v, 95), p99: pct(v, 99) };
console.log(JSON.stringify(out));
process.exit(0);
