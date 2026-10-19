// Creates the 7 tables and fills them with deterministic synthetic data (seeded RNG),
// roughly the shape of the app the numbers in the issue came from:
// ~21k users, ~24k user-role rows, 500 items with translations, ~500k messages, ~12k links.
//   PGHOST=localhost PGPORT=5440 PGUSER=bench PGPASSWORD=bench PGDATABASE=bench node seed.mjs
import { createHash } from 'node:crypto';
import pg from 'pg';

const N = { users: 21000, roles: 10, items: 500, messages: 500000, links: 12000 };
// mulberry32: small seeded PRNG, so every run produces the same data
let s = 42;
const rnd = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
// unique and deterministic: uuid-shaped hash of a counter
let idNo = 0;
const uuid = () => { const h = createHash('sha1').update(String(idNo++)).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const day = 86400000;
const t0 = Date.parse('2025-01-01T00:00:00Z');
const ts = () => new Date(t0 + Math.floor(rnd() * 600 * day));

const c = new pg.Client({
  host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5440),
  user: process.env.PGUSER || 'bench', password: process.env.PGPASSWORD || 'bench', database: process.env.PGDATABASE || 'bench',
});
await c.connect();
await c.query(`
  DROP TABLE IF EXISTS "Links", "Messages", "ItemTranslations", "Items", "UserRoles", "Roles", "Users";
  CREATE TABLE "Users" (id uuid PRIMARY KEY, email text, username varchar(255), "firstName" varchar(255), "lastName" varchar(255), "organizationId" uuid, "preferredLanguage" varchar(16));
  CREATE TABLE "Roles" (id uuid PRIMARY KEY, key varchar(255), name varchar(255), priority int);
  CREATE TABLE "UserRoles" (id uuid PRIMARY KEY, "userId" uuid, "roleId" uuid, "isActive" boolean, "expiresAt" timestamptz);
  CREATE TABLE "Items" (id uuid PRIMARY KEY, type varchar(64), "isPublic" boolean, "isActive" boolean, "displayOrder" int, "createdAt" timestamptz);
  CREATE TABLE "ItemTranslations" (id uuid PRIMARY KEY, "itemId" uuid, language varchar(16), name varchar(255));
  CREATE TABLE "Messages" (id uuid PRIMARY KEY, "userId" uuid, type varchar(64), title varchar(255), "isRead" boolean, "createdAt" timestamptz);
  CREATE TABLE "Links" (id uuid PRIMARY KEY, "userId" uuid, "otherId" uuid, status varchar(32));
`);
async function insert(table, cols, rows) {
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000); const params = [];
    const tuples = chunk.map((r) => `(${r.map((v) => { params.push(v); return `$${params.length}`; }).join(', ')})`);
    await c.query(`INSERT INTO "${table}" (${cols.map((x) => `"${x}"`).join(', ')}) VALUES ${tuples.join(', ')}`, params);
  }
  console.log(`${table}: ${rows.length}`);
}
const roles = Array.from({ length: N.roles }, (_, i) => [uuid(), `role_${i}`, `Role ${i}`, i * 10]);
await insert('Roles', ['id', 'key', 'name', 'priority'], roles);
const users = Array.from({ length: N.users }, (_, i) => [uuid(), `user${i}@example.com`, `user_${i}`, `First${i}`, `Last${i}`, rnd() < 0.2 ? uuid() : null, pick(['en', 'en', 'tr', 'de'])]);
await insert('Users', ['id', 'email', 'username', 'firstName', 'lastName', 'organizationId', 'preferredLanguage'], users);
const ur = [];
for (const u of users) {
  ur.push([uuid(), u[0], roles[0][0], true, null]);
  if (rnd() < 0.13) ur.push([uuid(), u[0], pick(roles.slice(1))[0], rnd() < 0.7, rnd() < 0.3 ? ts() : null]);
}
await insert('UserRoles', ['id', 'userId', 'roleId', 'isActive', 'expiresAt'], ur);
const items = Array.from({ length: N.items }, () => [uuid(), pick(['standard', 'premium', 'free']), rnd() < 0.8, rnd() < 0.9, rnd() < 0.3 ? null : Math.floor(rnd() * 1000), ts()]);
await insert('Items', ['id', 'type', 'isPublic', 'isActive', 'displayOrder', 'createdAt'], items);
const tr = [];
for (const it of items) for (const lang of ['en', 'tr']) if (rnd() < 0.9) tr.push([uuid(), it[0], lang, `${lang} name ${it[0].slice(0, 8)}`]);
await insert('ItemTranslations', ['id', 'itemId', 'language', 'name'], tr);
const active = users.filter(() => rnd() < 0.6);
const msgs = Array.from({ length: N.messages }, () => [uuid(), pick(active)[0], pick(['info', 'reward', 'system']), 'Hello there', rnd() < 0.5, ts()]);
await insert('Messages', ['id', 'userId', 'type', 'title', 'isRead', 'createdAt'], msgs);
const links = Array.from({ length: N.links }, () => [uuid(), pick(users)[0], pick(users)[0], rnd() < 0.6 ? 'accepted' : 'pending']);
await insert('Links', ['id', 'userId', 'otherId', 'status'], links);
await c.query(`
  CREATE UNIQUE INDEX ON "UserRoles" ("userId", "roleId");
  CREATE INDEX ON "UserRoles" ("roleId");
  CREATE INDEX ON "Items" ("isActive");
  CREATE INDEX ON "Items" ("isPublic");
  CREATE UNIQUE INDEX ON "ItemTranslations" ("itemId", language);
  CREATE INDEX ON "Messages" ("userId", "createdAt" DESC);
  CREATE INDEX ON "Links" ("userId");
  CREATE INDEX ON "Links" ("otherId");
  CREATE INDEX ON "Links" (status);
`);
await c.query('VACUUM ANALYZE');
console.log('done');
await c.end();
