// Deterministic synthetic data (seeded PRNG + counter-hashed UUIDs): the same rows on every
// database and every run. Roughly 21k users, 24k user-role rows, 10 roles, 500 items with ~900
// translations, 500k messages and 12k links.
import { createHash } from 'node:crypto';

export const TABLES = [
  ['Users', [['id', 'uuid'], ['email', 'text'], ['username', 'varchar(255)'], ['firstName', 'varchar(255)'], ['lastName', 'varchar(255)'], ['organizationId', 'uuid'], ['preferredLanguage', 'varchar(16)']]],
  ['Roles', [['id', 'uuid'], ['key', 'varchar(255)'], ['name', 'varchar(255)'], ['priority', 'int']]],
  ['UserRoles', [['id', 'uuid'], ['userId', 'uuid'], ['roleId', 'uuid'], ['isActive', 'boolean'], ['expiresAt', 'timestamptz']]],
  ['Items', [['id', 'uuid'], ['type', 'varchar(64)'], ['isPublic', 'boolean'], ['isActive', 'boolean'], ['displayOrder', 'int'], ['createdAt', 'timestamptz']]],
  ['ItemTranslations', [['id', 'uuid'], ['itemId', 'uuid'], ['language', 'varchar(16)'], ['name', 'varchar(255)']]],
  ['Messages', [['id', 'uuid'], ['userId', 'uuid'], ['type', 'varchar(64)'], ['title', 'varchar(255)'], ['isRead', 'boolean'], ['createdAt', 'timestamptz']]],
  ['Links', [['id', 'uuid'], ['userId', 'uuid'], ['otherId', 'uuid'], ['status', 'varchar(32)']]],
];
// the indexes the four queries can use (same on every SQL database)
export const INDEXES = [
  ['UserRoles', ['userId', 'roleId'], true], ['UserRoles', ['roleId']], ['Items', ['isActive']], ['Items', ['isPublic']],
  ['ItemTranslations', ['itemId', 'language'], true], ['Messages', ['userId', 'createdAt DESC']], ['Links', ['userId']], ['Links', ['otherId']], ['Links', ['status']],
];

export function generate() {
  const N = { users: 21000, roles: 10, items: 500, messages: 500000, links: 12000 };
  let s = 42; // mulberry32
  const rnd = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let idNo = 0;
  const uuid = () => { const h = createHash('sha1').update(String(idNo++)).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const t0 = Date.parse('2025-01-01T00:00:00Z');
  const ts = () => new Date(t0 + Math.floor(rnd() * 600 * 86400000));
  const future = () => new Date(Date.parse('2030-01-01T00:00:00Z') + Math.floor(rnd() * 365 * 86400000));
  const Roles = Array.from({ length: N.roles }, (_, i) => [uuid(), `role_${i}`, `Role ${i}`, i * 10]);
  const Users = Array.from({ length: N.users }, (_, i) => [uuid(), `user${i}@example.com`, `user_${i}`, `First${i}`, `Last${i}`, rnd() < 0.2 ? uuid() : null, pick(['en', 'en', 'tr', 'de'])]);
  const UserRoles = [];
  for (const u of Users) {
    UserRoles.push([uuid(), u[0], Roles[0][0], true, null]);
    // like the app: an active assignment has no expiry or one in the future (expired ones get
    // deactivated), so filtering on isActive alone and isActive + expiresAt return the same rows
    if (rnd() < 0.13) { const active = rnd() < 0.7; UserRoles.push([uuid(), u[0], pick(Roles.slice(1))[0], active, rnd() < 0.3 ? (active ? future() : ts()) : null]); }
  }
  const Items = Array.from({ length: N.items }, () => [uuid(), pick(['standard', 'premium', 'free']), rnd() < 0.8, rnd() < 0.9, rnd() < 0.3 ? null : Math.floor(rnd() * 1000), ts()]);
  const ItemTranslations = [];
  for (const it of Items) for (const lang of ['en', 'tr']) if (rnd() < 0.9) ItemTranslations.push([uuid(), it[0], lang, `${lang} name ${it[0].slice(0, 8)}`]);
  const active = Users.filter(() => rnd() < 0.6);
  const Messages = Array.from({ length: N.messages }, () => [uuid(), pick(active)[0], pick(['info', 'reward', 'system']), 'Hello there', rnd() < 0.5, ts()]);
  const Links = Array.from({ length: N.links }, () => [uuid(), pick(Users)[0], pick(Users)[0], rnd() < 0.6 ? 'accepted' : 'pending']);
  return { Users, Roles, UserRoles, Items, ItemTranslations, Messages, Links };
}
