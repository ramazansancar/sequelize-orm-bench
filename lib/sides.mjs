// Every side of the benchmark. A side is "<library>@<database>"; it returns q1..q4 with the same
// result shapes everywhere (q1: { id, roles[] } | null, q2/q3: id lists, q4: number) and close().
//   q1  user by primary key with active roles (many-to-many through UserRoles)
//   q2  public active items + their 'en' translation, displayOrder ASC NULLS LAST, createdAt DESC, 40
//   q3  a user's 20 newest messages
//   q4  count of a user's accepted links (userId = id OR otherId = id)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { DB, pgUrl } from './config.mjs';
import { defineModels } from './models.mjs';
import 'reflect-metadata';

const require = createRequire(import.meta.url);
const ver = (n) => JSON.parse(readFileSync(new URL(`../node_modules/${n}/package.json`, import.meta.url), 'utf8')).version;
const flat = (rows) => (rows.length ? { id: rows[0].id, roles: rows.filter((r) => r.key).map((r) => r.key).sort() } : null);

// same SQL text for the plain drivers and SQL-first libraries
const SQL = {
  q1: (p) => `SELECT u.id, u.email, u.username, u."firstName", u."lastName", u."organizationId", u."preferredLanguage", r.key, r.name, r.priority FROM "Users" u LEFT JOIN "UserRoles" ur ON ur."userId" = u.id AND ur."isActive" = true LEFT JOIN "Roles" r ON r.id = ur."roleId" WHERE u.id = ${p(1)}`,
  q2: () => `SELECT i.id, i.type, i."isPublic", i."displayOrder", i."createdAt", t.name FROM "Items" i LEFT JOIN "ItemTranslations" t ON t."itemId" = i.id AND t.language = 'en' WHERE i."isActive" = true AND i."isPublic" = true ORDER BY i."displayOrder" ASC NULLS LAST, i."createdAt" DESC LIMIT 40`,
  q3: (p) => `SELECT id, type, title, "isRead", "createdAt" FROM "Messages" WHERE "userId" = ${p(1)} ORDER BY "createdAt" DESC LIMIT 20`,
  q4: (p) => `SELECT count(*)::int AS n FROM "Links" WHERE status = 'accepted' AND ("userId" = ${p(1)} OR "otherId" = ${p(1)})`,
};
const dollar = (i) => `$${i}`;
const rawShape = (run) => ({
  q1: async (id) => flat(await run('q1', id)),
  q2: async () => (await run('q2')).map((r) => r.id),
  q3: async (id) => (await run('q3', id)).map((r) => r.id),
  q4: async (id) => Number((await run('q4', id))[0].n),
});

function sequelizeQueries(m, Op, log) {
  const { User, Role, Item, ItemTranslation, Message, Link } = m;
  const logging = log ? (s) => log.push(s) : false;
  return {
    q1: async (id) => {
      const u = await User.findByPk(id, { logging, attributes: ['id', 'email', 'username', 'firstName', 'lastName', 'organizationId', 'preferredLanguage'], include: [{ model: Role, as: 'roles', attributes: ['id', 'key', 'name', 'priority'], through: { attributes: [] } }] });
      return u ? { id: u.id, roles: u.roles.map((r) => r.key).sort() } : null;
    },
    q2: async () => (await Item.findAll({ logging, attributes: ['id', 'type', 'isPublic', 'displayOrder', 'createdAt'], where: { isActive: true, isPublic: true }, include: [{ model: ItemTranslation, as: 'translations', attributes: ['name'], where: { language: 'en' }, required: false }], order: [['displayOrder', 'ASC NULLS LAST'], ['createdAt', 'DESC']], limit: 40 })).map((i) => i.id),
    q3: async (id) => (await Message.findAll({ logging, attributes: ['id', 'type', 'title', 'isRead', 'createdAt'], where: { userId: id }, order: [['createdAt', 'DESC']], limit: 20 })).map((x) => x.id),
    q4: async (id) => Number(await Link.count({ logging, where: { status: 'accepted', [Op.or]: [{ userId: id }, { otherId: id }] } })),
  };
}

export async function makeSide(name, conc, log) {
  const [lib, db] = name.split('@');
  const C = DB[db];
  if (!C) throw new Error(`unknown database in ${name}`);
  const minPool = Math.min(2, conc);

  // ---------- ClickHouse (raw client and Kysely; the same rows, ClickHouse SQL) ----------
  if (db === 'ch') {
    const CHSQL = {
      q1: `SELECT u.id AS id, r.key AS key FROM "Users" u LEFT JOIN "UserRoles" ur ON ur."userId" = u.id AND ur."isActive" = true LEFT JOIN "Roles" r ON r.id = ur."roleId" WHERE u.id = {id:UUID}`,
      q2: `SELECT i.id AS id FROM "Items" i LEFT JOIN "ItemTranslations" t ON t."itemId" = i.id AND t.language = 'en' WHERE i."isActive" = true AND i."isPublic" = true ORDER BY i."displayOrder" ASC NULLS LAST, i."createdAt" DESC LIMIT 40`,
      q3: `SELECT id FROM "Messages" WHERE "userId" = {id:UUID} ORDER BY "createdAt" DESC LIMIT 20`,
      q4: `SELECT toInt32(count()) AS n FROM "Links" WHERE status = 'accepted' AND ("userId" = {id:UUID} OR "otherId" = {id:UUID})`,
    };
    const opts = { ...C, max_open_connections: conc, clickhouse_settings: { join_use_nulls: 1 } };
    if (lib === 'clickhouse') {
      const { createClient } = require('@clickhouse/client');
      const ch = createClient(opts);
      return { versions: { '@clickhouse/client': ver('@clickhouse/client') }, ...rawShape(async (q, id) => { log?.push(CHSQL[q]); return (await ch.query({ query: CHSQL[q], query_params: { id }, format: 'JSONEachRow' })).json(); }), close: () => ch.close() };
    }
    if (lib === 'kysely') {
      const { Kysely, sql } = require('kysely');
      const { ClickhouseDialect } = require('@founderpath/kysely-clickhouse');
      const k = new Kysely({ dialect: new ClickhouseDialect({ options: opts }), log: log ? (e) => log.push(e.query.sql) : undefined });
      return {
        versions: { kysely: ver('kysely'), '@founderpath/kysely-clickhouse': ver('@founderpath/kysely-clickhouse') },
        ...rawShape(async (q, id) => {
          if (q === 'q1') return k.selectFrom('Users as u').leftJoin('UserRoles as ur', (j) => j.onRef('ur.userId', '=', 'u.id').on('ur.isActive', '=', sql.lit(true))).leftJoin('Roles as r', 'r.id', 'ur.roleId').select(['u.id as id', 'r.key as key', 'r.name', 'r.priority']).where('u.id', '=', id).execute();
          if (q === 'q2') return k.selectFrom('Items as i').leftJoin('ItemTranslations as t', (j) => j.onRef('t.itemId', '=', 'i.id').on('t.language', '=', sql.lit('en'))).select(['i.id as id', 'i.type', 'i.displayOrder', 'i.createdAt', 't.name']).where('i.isActive', '=', sql.lit(true)).where('i.isPublic', '=', sql.lit(true)).orderBy(sql`i."displayOrder" asc nulls last`).orderBy('i.createdAt', 'desc').limit(40).execute();
          if (q === 'q3') return k.selectFrom('Messages').select(['id', 'type', 'title', 'isRead', 'createdAt']).where('userId', '=', id).orderBy('createdAt', 'desc').limit(20).execute();
          return k.selectFrom('Links').select(sql`toInt32(count())`.as('n')).where('status', '=', 'accepted').where((e) => e.or([e('userId', '=', id), e('otherId', '=', id)])).execute();
        }),
        close: () => k.destroy(),
      };
    }
    throw new Error(`${lib} does not support ClickHouse`);
  }

  // ---------- plain drivers ----------
  if (lib === 'pg' || lib === 'pg-native') {
    const pg = require('pg');
    const Pool = lib === 'pg-native' ? pg.native.Pool : pg.Pool;
    const pool = new Pool({ ...C, max: conc });
    return { versions: { pg: ver('pg'), ...(lib === 'pg-native' ? { 'pg-native': ver('pg-native') } : {}) }, ...rawShape(async (q, id) => { const t = SQL[q](dollar); log?.push(t); return (await pool.query(t, id === undefined ? [] : [id])).rows; }), close: () => pool.end() };
  }
  if (lib === 'postgresjs') {
    const postgres = require('postgres');
    const sql = postgres({ ...C, username: C.user, max: conc, prepare: true, ...(log ? { debug: (_c, t) => log.push(t) } : {}) });
    const T = {
      q1: (id) => sql`SELECT u.id, u.email, u.username, u."firstName", u."lastName", u."organizationId", u."preferredLanguage", r.key, r.name, r.priority FROM "Users" u LEFT JOIN "UserRoles" ur ON ur."userId" = u.id AND ur."isActive" = true LEFT JOIN "Roles" r ON r.id = ur."roleId" WHERE u.id = ${id}`,
      q2: () => sql`SELECT i.id, i.type, i."isPublic", i."displayOrder", i."createdAt", t.name FROM "Items" i LEFT JOIN "ItemTranslations" t ON t."itemId" = i.id AND t.language = 'en' WHERE i."isActive" = true AND i."isPublic" = true ORDER BY i."displayOrder" ASC NULLS LAST, i."createdAt" DESC LIMIT 40`,
      q3: (id) => sql`SELECT id, type, title, "isRead", "createdAt" FROM "Messages" WHERE "userId" = ${id} ORDER BY "createdAt" DESC LIMIT 20`,
      q4: (id) => sql`SELECT count(*)::int AS n FROM "Links" WHERE status = 'accepted' AND ("userId" = ${id} OR "otherId" = ${id})`,
    };
    return { versions: { postgres: ver('postgres') }, ...rawShape(async (q, id) => [...(await T[q](id))]), close: () => sql.end() };
  }
  if (lib === 'pgpromise') {
    const pgp = require('pg-promise')();
    const dbp = pgp({ ...C, max: conc });
    return { versions: { 'pg-promise': ver('pg-promise') }, ...rawShape((q, id) => { const t = SQL[q](dollar); log?.push(t); return dbp.any(t, id === undefined ? [] : [id]); }), close: () => pgp.end() };
  }
  if (lib === 'databases') {
    const { default: createConnectionPool, sql } = await import('@databases/pg');
    const dbp = createConnectionPool({ connectionString: pgUrl(C), poolSize: conc, bigIntMode: 'number', onQueryStart: log ? (_q, { text }) => { log.push(text); } : undefined });
    const T = {
      q1: (id) => sql`SELECT u.id, u.email, u.username, u."firstName", u."lastName", u."organizationId", u."preferredLanguage", r.key, r.name, r.priority FROM "Users" u LEFT JOIN "UserRoles" ur ON ur."userId" = u.id AND ur."isActive" = true LEFT JOIN "Roles" r ON r.id = ur."roleId" WHERE u.id = ${id}`,
      q2: () => sql`SELECT i.id, i.type, i."isPublic", i."displayOrder", i."createdAt", t.name FROM "Items" i LEFT JOIN "ItemTranslations" t ON t."itemId" = i.id AND t.language = 'en' WHERE i."isActive" = true AND i."isPublic" = true ORDER BY i."displayOrder" ASC NULLS LAST, i."createdAt" DESC LIMIT 40`,
      q3: (id) => sql`SELECT id, type, title, "isRead", "createdAt" FROM "Messages" WHERE "userId" = ${id} ORDER BY "createdAt" DESC LIMIT 20`,
      q4: (id) => sql`SELECT count(*)::int AS n FROM "Links" WHERE status = 'accepted' AND ("userId" = ${id} OR "otherId" = ${id})`,
    };
    return { versions: { '@databases/pg': ver('@databases/pg') }, ...rawShape((q, id) => dbp.query(T[q](id))), close: () => dbp.dispose() };
  }
  if (lib === 'slonik') {
    const { createPool, sql } = await import('slonik');
    const pool = await createPool(pgUrl(C), { maximumPoolSize: conc, minimumPoolSize: minPool });
    const T = {
      q1: (id) => sql.unsafe`SELECT u.id, u.email, u.username, u."firstName", u."lastName", u."organizationId", u."preferredLanguage", r.key, r.name, r.priority FROM "Users" u LEFT JOIN "UserRoles" ur ON ur."userId" = u.id AND ur."isActive" = true LEFT JOIN "Roles" r ON r.id = ur."roleId" WHERE u.id = ${id}`,
      q2: () => sql.unsafe`SELECT i.id, i.type, i."isPublic", i."displayOrder", i."createdAt", t.name FROM "Items" i LEFT JOIN "ItemTranslations" t ON t."itemId" = i.id AND t.language = 'en' WHERE i."isActive" = true AND i."isPublic" = true ORDER BY i."displayOrder" ASC NULLS LAST, i."createdAt" DESC LIMIT 40`,
      q3: (id) => sql.unsafe`SELECT id, type, title, "isRead", "createdAt" FROM "Messages" WHERE "userId" = ${id} ORDER BY "createdAt" DESC LIMIT 20`,
      q4: (id) => sql.unsafe`SELECT count(*)::int AS n FROM "Links" WHERE status = 'accepted' AND ("userId" = ${id} OR "otherId" = ${id})`,
    };
    return { versions: { slonik: ver('slonik') }, ...rawShape(async (q, id) => { const t = T[q](id); log?.push(t.sql); return [...(await pool.any(t))]; }), close: () => pool.end() };
  }

  // ---------- Sequelize (v6, v7; ORM path and raw sequelize.query path) ----------
  //   sequelize7:<name>  = @sequelize/core from a local build in builds/<name>/ (see builds.mjs)
  if (/^sequelize[67]/.test(lib)) {
    const [base, build] = lib.split(':');
    const v7 = base.startsWith('sequelize7');
    const native = base.endsWith('-native');
    const rawPath = base.includes('-raw');
    let S; let sequelize; let versions;
    if (v7) {
      const from = build ? createRequire(new URL(`../builds/${build}/package.json`, import.meta.url)) : require;
      S = from('@sequelize/core');
      const { PostgresDialect } = from('@sequelize/postgres');
      sequelize = new S.Sequelize({ dialect: PostgresDialect, ...C, native, logging: false, pool: { max: conc, min: minPool } });
      versions = { '@sequelize/core': build ? `${ver(`../builds/${build}/node_modules/@sequelize/core`)} (${build} ${readFileSync(new URL(`../builds/${build}/COMMIT`, import.meta.url), 'utf8').trim().slice(0, 9)})` : ver('@sequelize/core') };
    } else {
      S = db === 'crdb' ? require('sequelize-cockroachdb') : require('sequelize');
      sequelize = new S.Sequelize(C.database, C.user, C.password, { host: C.host, port: C.port, dialect: 'postgres', native, logging: false, pool: { max: conc, min: minPool } });
      versions = { sequelize: ver('sequelize'), ...(db === 'crdb' ? { 'sequelize-cockroachdb': ver('sequelize-cockroachdb') } : {}) };
    }
    if (native) versions['pg-native'] = ver('pg-native');
    if (rawPath) {
      return { versions, ...rawShape((q, id) => { const t = SQL[q](dollar); log?.push(t); return sequelize.query(t, { bind: id === undefined ? [] : [id], type: S.QueryTypes.SELECT }); }), close: () => sequelize.close() };
    }
    const m = defineModels(sequelize, { DataTypes: S.DataTypes, Op: S.Op, literal: S.literal });
    return { versions, ...sequelizeQueries(m, S.Op, log), close: () => sequelize.close() };
  }

  // ---------- TypeORM ----------
  if (lib === 'typeorm' || lib === 'typeorm-native') {
    const { DataSource, EntitySchema } = require('typeorm');
    const col = (type, extra = {}) => ({ type, ...extra });
    const User = new EntitySchema({ name: 'User', tableName: 'Users', columns: { id: col('uuid', { primary: true }), email: col('text'), username: col('varchar'), firstName: col('varchar'), lastName: col('varchar'), organizationId: col('uuid', { nullable: true }), preferredLanguage: col('varchar') }, relations: { userRoles: { type: 'one-to-many', target: 'UserRole', inverseSide: 'user' } } });
    const Role = new EntitySchema({ name: 'Role', tableName: 'Roles', columns: { id: col('uuid', { primary: true }), key: col('varchar'), name: col('varchar'), priority: col('int') } });
    const UserRole = new EntitySchema({ name: 'UserRole', tableName: 'UserRoles', columns: { id: col('uuid', { primary: true }), userId: col('uuid'), roleId: col('uuid'), isActive: col('boolean') }, relations: { user: { type: 'many-to-one', target: 'User', joinColumn: { name: 'userId' } }, role: { type: 'many-to-one', target: 'Role', joinColumn: { name: 'roleId' } } } });
    const Item = new EntitySchema({ name: 'Item', tableName: 'Items', columns: { id: col('uuid', { primary: true }), type: col('varchar'), isPublic: col('boolean'), isActive: col('boolean'), displayOrder: col('int', { nullable: true }), createdAt: col('timestamptz') }, relations: { translations: { type: 'one-to-many', target: 'ItemTranslation', inverseSide: 'item' } } });
    const ItemTranslation = new EntitySchema({ name: 'ItemTranslation', tableName: 'ItemTranslations', columns: { id: col('uuid', { primary: true }), itemId: col('uuid'), language: col('varchar'), name: col('varchar') }, relations: { item: { type: 'many-to-one', target: 'Item', joinColumn: { name: 'itemId' } } } });
    const Message = new EntitySchema({ name: 'Message', tableName: 'Messages', columns: { id: col('uuid', { primary: true }), userId: col('uuid'), type: col('varchar'), title: col('varchar'), isRead: col('boolean'), createdAt: col('timestamptz') } });
    const Link = new EntitySchema({ name: 'Link', tableName: 'Links', columns: { id: col('uuid', { primary: true }), userId: col('uuid'), otherId: col('uuid'), status: col('varchar') } });
    const logger = log ? { logQuery: (q) => log.push(q), logQueryError() {}, logQuerySlow() {}, logSchemaBuild() {}, logMigration() {}, log() {} } : undefined;
    // TypeORM switches to pg-native by itself when it is installed; for the plain side hide it
    const pg = require('pg');
    const driver = lib === 'typeorm' ? new Proxy(pg, { get: (t, k) => (k === 'native' ? undefined : t[k]) }) : pg;
    const ds = new DataSource({ type: db === 'crdb' ? 'cockroachdb' : 'postgres', host: C.host, port: C.port, username: C.user, password: C.password, database: C.database, entities: [User, Role, UserRole, Item, ItemTranslation, Message, Link], synchronize: false, logging: !!log, logger, poolSize: conc, driver, ...(db === 'crdb' ? { timeTravelQueries: false } : {}) });
    await ds.initialize();
    const users = ds.getRepository('User'); const items = ds.getRepository('Item'); const msgs = ds.getRepository('Message'); const links = ds.getRepository('Link');
    return {
      versions: { typeorm: ver('typeorm'), ...(lib === 'typeorm-native' ? { 'pg-native': ver('pg-native') } : {}) },
      q1: async (id) => { const u = await users.createQueryBuilder('u').leftJoinAndSelect('u.userRoles', 'ur', 'ur.isActive = :a', { a: true }).leftJoinAndSelect('ur.role', 'r').select(['u.id', 'u.email', 'u.username', 'u.firstName', 'u.lastName', 'u.organizationId', 'u.preferredLanguage', 'ur.id', 'r.id', 'r.key', 'r.name', 'r.priority']).where('u.id = :id', { id }).getOne(); return u ? { id: u.id, roles: u.userRoles.map((ur) => ur.role?.key).filter(Boolean).sort() } : null; },
      q2: async () => (await items.createQueryBuilder('i').leftJoinAndSelect('i.translations', 't', 't.language = :l', { l: 'en' }).select(['i.id', 'i.type', 'i.isPublic', 'i.displayOrder', 'i.createdAt', 't.id', 't.name']).where('i.isActive = :a AND i.isPublic = :a', { a: true }).orderBy('i.displayOrder', 'ASC', 'NULLS LAST').addOrderBy('i.createdAt', 'DESC').limit(40).getMany()).map((i) => i.id),
      q3: async (id) => (await msgs.find({ select: { id: true, type: true, title: true, isRead: true, createdAt: true }, where: { userId: id }, order: { createdAt: 'DESC' }, take: 20 })).map((x) => x.id),
      q4: async (id) => links.count({ where: [{ status: 'accepted', userId: id }, { status: 'accepted', otherId: id }] }),
      close: () => ds.destroy(),
    };
  }

  // ---------- Knex ----------
  if (lib === 'knex' || lib === 'knex-native') {
    const k = require('knex')({ client: db === 'crdb' ? 'cockroachdb' : lib === 'knex-native' ? 'pgnative' : 'pg', connection: C, pool: { min: minPool, max: conc } });
    if (log) k.on('query', (q) => log.push(q.sql));
    return {
      versions: { knex: ver('knex'), ...(lib === 'knex-native' ? { 'pg-native': ver('pg-native') } : {}) },
      ...rawShape(async (q, id) => {
        if (q === 'q1') return k('Users as u').leftJoin('UserRoles as ur', function () { this.on('ur.userId', '=', 'u.id').andOn('ur.isActive', '=', k.raw('?', [true])); }).leftJoin('Roles as r', 'r.id', 'ur.roleId').select('u.id', 'u.email', 'u.username', 'u.firstName', 'u.lastName', 'u.organizationId', 'u.preferredLanguage', 'r.key', 'r.name', 'r.priority').where('u.id', id);
        if (q === 'q2') return k('Items as i').leftJoin('ItemTranslations as t', function () { this.on('t.itemId', '=', 'i.id').andOn('t.language', '=', k.raw('?', ['en'])); }).select('i.id', 'i.type', 'i.isPublic', 'i.displayOrder', 'i.createdAt', 't.name').where('i.isActive', true).andWhere('i.isPublic', true).orderByRaw('"i"."displayOrder" asc nulls last').orderBy('i.createdAt', 'desc').limit(40);
        if (q === 'q3') return k('Messages').select('id', 'type', 'title', 'isRead', 'createdAt').where('userId', id).orderBy('createdAt', 'desc').limit(20);
        return [await k('Links').count('* as n').where('status', 'accepted').andWhere((qb) => qb.where('userId', id).orWhere('otherId', id)).first()];
      }),
      close: () => k.destroy(),
    };
  }

  // ---------- drizzle ----------
  if (lib === 'drizzle') {
    const pg = require('pg');
    const pool = new pg.Pool({ ...C, max: conc });
    const { drizzle } = require('drizzle-orm/node-postgres');
    const { pgTable, uuid, text, varchar, boolean, integer, timestamp } = require('drizzle-orm/pg-core');
    const { eq, and, or, desc, sql, count } = require('drizzle-orm');
    const users = pgTable('Users', { id: uuid('id').primaryKey(), email: text('email'), username: varchar('username'), firstName: varchar('firstName'), lastName: varchar('lastName'), organizationId: uuid('organizationId'), preferredLanguage: varchar('preferredLanguage') });
    const userRoles = pgTable('UserRoles', { id: uuid('id').primaryKey(), userId: uuid('userId'), roleId: uuid('roleId'), isActive: boolean('isActive') });
    const roles = pgTable('Roles', { id: uuid('id').primaryKey(), key: varchar('key'), name: varchar('name'), priority: integer('priority') });
    const items = pgTable('Items', { id: uuid('id').primaryKey(), type: varchar('type'), isPublic: boolean('isPublic'), isActive: boolean('isActive'), displayOrder: integer('displayOrder'), createdAt: timestamp('createdAt', { withTimezone: true }) });
    const tr = pgTable('ItemTranslations', { id: uuid('id').primaryKey(), itemId: uuid('itemId'), language: varchar('language'), name: varchar('name') });
    const msgs = pgTable('Messages', { id: uuid('id').primaryKey(), userId: uuid('userId'), type: varchar('type'), title: varchar('title'), isRead: boolean('isRead'), createdAt: timestamp('createdAt', { withTimezone: true }) });
    const links = pgTable('Links', { id: uuid('id').primaryKey(), userId: uuid('userId'), otherId: uuid('otherId'), status: varchar('status') });
    const d = drizzle({ client: pool, logger: log ? { logQuery: (q) => log.push(q) } : false });
    return {
      versions: { 'drizzle-orm': ver('drizzle-orm') },
      ...rawShape(async (q, id) => {
        if (q === 'q1') return d.select({ id: users.id, email: users.email, username: users.username, firstName: users.firstName, lastName: users.lastName, organizationId: users.organizationId, preferredLanguage: users.preferredLanguage, key: roles.key, name: roles.name, priority: roles.priority }).from(users).leftJoin(userRoles, and(eq(userRoles.userId, users.id), eq(userRoles.isActive, true))).leftJoin(roles, eq(roles.id, userRoles.roleId)).where(eq(users.id, id));
        if (q === 'q2') return d.select({ id: items.id, type: items.type, isPublic: items.isPublic, displayOrder: items.displayOrder, createdAt: items.createdAt, name: tr.name }).from(items).leftJoin(tr, and(eq(tr.itemId, items.id), eq(tr.language, 'en'))).where(and(eq(items.isActive, true), eq(items.isPublic, true))).orderBy(sql`${items.displayOrder} asc nulls last`, desc(items.createdAt)).limit(40);
        if (q === 'q3') return d.select({ id: msgs.id, type: msgs.type, title: msgs.title, isRead: msgs.isRead, createdAt: msgs.createdAt }).from(msgs).where(eq(msgs.userId, id)).orderBy(desc(msgs.createdAt)).limit(20);
        return d.select({ n: count() }).from(links).where(and(eq(links.status, 'accepted'), or(eq(links.userId, id), eq(links.otherId, id))));
      }),
      close: () => pool.end(),
    };
  }

  // ---------- Kysely ----------
  if (lib === 'kysely') {
    const pg = require('pg');
    const { Kysely, PostgresDialect, sql } = require('kysely');
    const k = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ ...C, max: conc }) }), log: log ? (e) => log.push(e.query.sql) : undefined });
    return {
      versions: { kysely: ver('kysely') },
      ...rawShape(async (q, id) => {
        if (q === 'q1') return k.selectFrom('Users as u').leftJoin('UserRoles as ur', (j) => j.onRef('ur.userId', '=', 'u.id').on('ur.isActive', '=', true)).leftJoin('Roles as r', 'r.id', 'ur.roleId').select(['u.id', 'u.email', 'u.username', 'u.firstName', 'u.lastName', 'u.organizationId', 'u.preferredLanguage', 'r.key', 'r.name', 'r.priority']).where('u.id', '=', id).execute();
        if (q === 'q2') return k.selectFrom('Items as i').leftJoin('ItemTranslations as t', (j) => j.onRef('t.itemId', '=', 'i.id').on('t.language', '=', 'en')).select(['i.id', 'i.type', 'i.isPublic', 'i.displayOrder', 'i.createdAt', 't.name']).where('i.isActive', '=', true).where('i.isPublic', '=', true).orderBy(sql`i."displayOrder" asc nulls last`).orderBy('i.createdAt', 'desc').limit(40).execute();
        if (q === 'q3') return k.selectFrom('Messages').select(['id', 'type', 'title', 'isRead', 'createdAt']).where('userId', '=', id).orderBy('createdAt', 'desc').limit(20).execute();
        return k.selectFrom('Links').select((e) => e.fn.countAll().as('n')).where('status', '=', 'accepted').where((e) => e.or([e('userId', '=', id), e('otherId', '=', id)])).execute();
      }),
      close: () => k.destroy(),
    };
  }

  // ---------- PostgreSQL-only ORMs ----------
  if (db !== 'pg') throw new Error(`${lib} is only set up for PostgreSQL here`);

  if (lib === 'prisma') {
    // generated by `npx prisma generate` (TypeScript output, loaded through tsx — run.mjs adds it)
    const { PrismaClient } = await import('../generated/prisma/client.ts');
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: pgUrl(C), max: conc }), log: log ? [{ emit: 'event', level: 'query' }] : [] });
    if (log) prisma.$on('query', (e) => log.push(e.query));
    return {
      versions: { prisma: ver('prisma'), '@prisma/adapter-pg': ver('@prisma/adapter-pg') },
      q1: async (id) => { const u = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true, username: true, firstName: true, lastName: true, organizationId: true, preferredLanguage: true, userRoles: { where: { isActive: true }, select: { role: { select: { id: true, key: true, name: true, priority: true } } } } } }); return u ? { id: u.id, roles: u.userRoles.map((ur) => ur.role.key).filter(Boolean).sort() } : null; },
      q2: async () => (await prisma.item.findMany({ where: { isActive: true, isPublic: true }, select: { id: true, type: true, isPublic: true, displayOrder: true, createdAt: true, translations: { where: { language: 'en' }, select: { name: true } } }, orderBy: [{ displayOrder: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }], take: 40 })).map((i) => i.id),
      q3: async (id) => (await prisma.message.findMany({ where: { userId: id }, select: { id: true, type: true, title: true, isRead: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 20 })).map((x) => x.id),
      q4: (id) => prisma.link.count({ where: { status: 'accepted', OR: [{ userId: id }, { otherId: id }] } }),
      close: () => prisma.$disconnect(),
    };
  }
  if (lib === 'objection') {
    const knex = require('knex')({ client: 'pg', connection: C, pool: { min: minPool, max: conc } });
    if (log) knex.on('query', (q) => log.push(q.sql));
    const { Model } = require('objection');
    Model.knex(knex);
    class Role extends Model { static tableName = 'Roles'; }
    // the join row is its own model: a ManyToMany `filter` lands inside the Roles subquery
    class UserRole extends Model { static tableName = 'UserRoles'; static relationMappings = () => ({ role: { relation: Model.BelongsToOneRelation, modelClass: Role, join: { from: 'UserRoles.roleId', to: 'Roles.id' } } }); }
    class User extends Model { static tableName = 'Users'; static relationMappings = () => ({ userRoles: { relation: Model.HasManyRelation, modelClass: UserRole, join: { from: 'Users.id', to: 'UserRoles.userId' } } }); }
    class ItemTranslation extends Model { static tableName = 'ItemTranslations'; }
    class Item extends Model { static tableName = 'Items'; static relationMappings = () => ({ translations: { relation: Model.HasManyRelation, modelClass: ItemTranslation, join: { from: 'Items.id', to: 'ItemTranslations.itemId' } } }); }
    class Message extends Model { static tableName = 'Messages'; }
    class Link extends Model { static tableName = 'Links'; }
    return {
      versions: { objection: ver('objection'), knex: ver('knex') },
      q1: async (id) => { const u = await User.query().findById(id).select('Users.id', 'email', 'username', 'firstName', 'lastName', 'organizationId', 'preferredLanguage').withGraphJoined('userRoles.role').modifyGraph('userRoles', (qb) => qb.select('id', 'roleId').where('isActive', true)).modifyGraph('userRoles.role', (qb) => qb.select('id', 'key', 'name', 'priority')); return u ? { id: u.id, roles: u.userRoles.map((ur) => ur.role?.key).filter(Boolean).sort() } : null; },
      q2: async () => (await Item.query().select('Items.id', 'type', 'isPublic', 'displayOrder', 'Items.createdAt').withGraphJoined('translations').modifyGraph('translations', (qb) => qb.select('name').where('language', 'en')).where('Items.isActive', true).andWhere('Items.isPublic', true).orderByRaw('"Items"."displayOrder" asc nulls last').orderBy('Items.createdAt', 'desc').limit(40)).map((i) => i.id),
      q3: async (id) => (await Message.query().select('id', 'type', 'title', 'isRead', 'createdAt').where('userId', id).orderBy('createdAt', 'desc').limit(20)).map((x) => x.id),
      q4: async (id) => Number((await Link.query().count('* as n').where('status', 'accepted').andWhere((qb) => qb.where('userId', id).orWhere('otherId', id)).first()).n),
      close: () => knex.destroy(),
    };
  }
  if (lib === 'orchid') {
    const { orchidORM } = await import('orchid-orm/node-postgres');
    const { createBaseTable } = await import('orchid-orm');
    const BaseTable = createBaseTable();
    class RoleTable extends BaseTable { table = 'Roles'; columns = this.setColumns((t) => ({ id: t.uuid().primaryKey(), key: t.varchar(255).nullable(), name: t.varchar(255).nullable(), priority: t.integer().nullable() })); }
    class UserRoleTable extends BaseTable { table = 'UserRoles'; columns = this.setColumns((t) => ({ id: t.uuid().primaryKey(), userId: t.uuid(), roleId: t.uuid(), isActive: t.boolean().nullable() })); relations = { role: this.belongsTo(() => RoleTable, { columns: ['roleId'], references: ['id'] }) }; }
    class UserTable extends BaseTable { table = 'Users'; columns = this.setColumns((t) => ({ id: t.uuid().primaryKey(), email: t.text().nullable(), username: t.varchar(255).nullable(), firstName: t.varchar(255).nullable(), lastName: t.varchar(255).nullable(), organizationId: t.uuid().nullable(), preferredLanguage: t.varchar(255).nullable() })); relations = { userRoles: this.hasMany(() => UserRoleTable, { columns: ['id'], references: ['userId'] }) }; }
    class TrTable extends BaseTable { table = 'ItemTranslations'; columns = this.setColumns((t) => ({ id: t.uuid().primaryKey(), itemId: t.uuid(), language: t.varchar(255), name: t.varchar(255).nullable() })); }
    class ItemTable extends BaseTable { table = 'Items'; columns = this.setColumns((t) => ({ id: t.uuid().primaryKey(), type: t.text().nullable(), isPublic: t.boolean().nullable(), isActive: t.boolean().nullable(), displayOrder: t.integer().nullable(), createdAt: t.timestamp() })); relations = { translations: this.hasMany(() => TrTable, { columns: ['id'], references: ['itemId'] }) }; }
    class MessageTable extends BaseTable { table = 'Messages'; columns = this.setColumns((t) => ({ id: t.uuid().primaryKey(), userId: t.uuid(), type: t.varchar(255).nullable(), title: t.varchar(255).nullable(), isRead: t.boolean().nullable(), createdAt: t.timestamp() })); }
    class LinkTable extends BaseTable { table = 'Links'; columns = this.setColumns((t) => ({ id: t.uuid().primaryKey(), userId: t.uuid(), otherId: t.uuid(), status: t.text() })); }
    const odb = orchidORM({ databaseURL: pgUrl(C), max: conc, log: log ? { log: (x) => log.push(String(x)) } : false }, { user: UserTable, role: RoleTable, userRole: UserRoleTable, item: ItemTable, tr: TrTable, message: MessageTable, link: LinkTable });
    return {
      versions: { 'orchid-orm': ver('orchid-orm') },
      q1: async (id) => { const u = await odb.user.findOptional(id).select('id', 'email', 'username', 'firstName', 'lastName', 'organizationId', 'preferredLanguage', { userRoles: (q) => q.userRoles.where({ isActive: true }).select({ role: (r) => r.role.select('id', 'key', 'name', 'priority') }) }); return u ? { id: u.id, roles: u.userRoles.map((ur) => ur.role?.key).filter(Boolean).sort() } : null; },
      q2: async () => (await odb.item.select('id', 'type', 'isPublic', 'displayOrder', 'createdAt', { translations: (q) => q.translations.where({ language: 'en' }).select('name') }).where({ isActive: true, isPublic: true }).order({ displayOrder: 'ASC NULLS LAST', createdAt: 'DESC' }).limit(40)).map((i) => i.id),
      q3: async (id) => (await odb.message.select('id', 'type', 'title', 'isRead', 'createdAt').where({ userId: id }).order({ createdAt: 'DESC' }).limit(20)).map((x) => x.id),
      q4: async (id) => Number(await odb.link.where({ status: 'accepted' }).where({ OR: [{ userId: id }, { otherId: id }] }).count()),
      close: () => odb.$close(),
    };
  }
  if (lib === 'zapatos') {
    const pg = require('pg');
    const z = await import('zapatos/db');
    const pool = new pg.Pool({ ...C, max: conc });
    if (log) z.setConfig({ queryListener: (q) => log.push(q.text) });
    return {
      versions: { zapatos: ver('zapatos') },
      q1: async (id) => { const u = await z.selectOne('Users', { id }, { columns: ['id', 'email', 'username', 'firstName', 'lastName', 'organizationId', 'preferredLanguage'], lateral: { roles: z.select('UserRoles', { userId: z.parent('id'), isActive: true }, { columns: [], lateral: { role: z.selectExactlyOne('Roles', { id: z.parent('roleId') }, { columns: ['id', 'key', 'name', 'priority'] }) } }) } }).run(pool); return u ? { id: u.id, roles: u.roles.map((ur) => ur.role.key).filter(Boolean).sort() } : null; },
      q2: async () => (await z.select('Items', { isActive: true, isPublic: true }, { columns: ['id', 'type', 'isPublic', 'displayOrder', 'createdAt'], lateral: { translations: z.select('ItemTranslations', { itemId: z.parent('id'), language: 'en' }, { columns: ['name'] }) }, order: [{ by: 'displayOrder', direction: 'ASC', nulls: 'LAST' }, { by: 'createdAt', direction: 'DESC' }], limit: 40 }).run(pool)).map((i) => i.id),
      q3: async (id) => (await z.select('Messages', { userId: id }, { columns: ['id', 'type', 'title', 'isRead', 'createdAt'], order: { by: 'createdAt', direction: 'DESC' }, limit: 20 }).run(pool)).map((x) => x.id),
      q4: async (id) => Number(await z.count('Links', z.sql`status = 'accepted' AND ("userId" = ${z.param(id)} OR "otherId" = ${z.param(id)})`).run(pool)),
      close: () => pool.end(),
    };
  }
  if (lib === 'mikroorm') {
    const { MikroORM, EntitySchema, EntityCaseNamingStrategy, QueryOrder } = await import('@mikro-orm/postgresql');
    const Role = new EntitySchema({ name: 'Role', tableName: 'Roles', properties: { id: { type: 'uuid', primary: true }, key: { type: 'string' }, name: { type: 'string' }, priority: { type: 'integer' } } });
    const UserRole = new EntitySchema({ name: 'UserRole', tableName: 'UserRoles', properties: { id: { type: 'uuid', primary: true }, isActive: { type: 'boolean' }, user: { kind: 'm:1', entity: () => User, fieldName: 'userId' }, role: { kind: 'm:1', entity: () => Role, fieldName: 'roleId' } } });
    const User = new EntitySchema({ name: 'User', tableName: 'Users', properties: { id: { type: 'uuid', primary: true }, email: { type: 'text' }, username: { type: 'string' }, firstName: { type: 'string' }, lastName: { type: 'string' }, organizationId: { type: 'uuid', nullable: true }, preferredLanguage: { type: 'string' }, userRoles: { kind: '1:m', entity: () => UserRole, mappedBy: 'user' } } });
    const ItemTranslation = new EntitySchema({ name: 'ItemTranslation', tableName: 'ItemTranslations', properties: { id: { type: 'uuid', primary: true }, language: { type: 'string' }, name: { type: 'string' }, item: { kind: 'm:1', entity: () => Item, fieldName: 'itemId' } } });
    const Item = new EntitySchema({ name: 'Item', tableName: 'Items', properties: { id: { type: 'uuid', primary: true }, type: { type: 'string' }, isPublic: { type: 'boolean' }, isActive: { type: 'boolean' }, displayOrder: { type: 'integer', nullable: true }, createdAt: { type: 'datetime' }, translations: { kind: '1:m', entity: () => ItemTranslation, mappedBy: 'item' } } });
    const Message = new EntitySchema({ name: 'Message', tableName: 'Messages', properties: { id: { type: 'uuid', primary: true }, userId: { type: 'uuid' }, type: { type: 'string' }, title: { type: 'string' }, isRead: { type: 'boolean' }, createdAt: { type: 'datetime' } } });
    const Link = new EntitySchema({ name: 'Link', tableName: 'Links', properties: { id: { type: 'uuid', primary: true }, userId: { type: 'uuid' }, otherId: { type: 'uuid' }, status: { type: 'string' } } });
    const orm = await MikroORM.init({ entities: [User, Role, UserRole, Item, ItemTranslation, Message, Link], dbName: C.database, host: C.host, port: C.port, user: C.user, password: C.password, namingStrategy: EntityCaseNamingStrategy, pool: { min: minPool, max: conc }, debug: log ? ['query'] : false, logger: (x) => log?.push(x), ensureDatabase: false });
    const em = () => orm.em.fork(); // one EntityManager per query, like one per request in an app
    return {
      versions: { '@mikro-orm/core': ver('@mikro-orm/core') },
      q1: async (id) => { const u = await em().findOne(User, { id }, { fields: ['id', 'email', 'username', 'firstName', 'lastName', 'organizationId', 'preferredLanguage', 'userRoles.role.id', 'userRoles.role.key', 'userRoles.role.name', 'userRoles.role.priority'], populate: ['userRoles.role'], populateWhere: { userRoles: { isActive: true } }, strategy: 'joined' }); return u ? { id: u.id, roles: u.userRoles.getItems().map((ur) => ur.role.key).sort() } : null; },
      q2: async () => (await em().find(Item, { isActive: true, isPublic: true }, { fields: ['id', 'type', 'isPublic', 'displayOrder', 'createdAt', 'translations.name'], populate: ['translations'], populateWhere: { translations: { language: 'en' } }, strategy: 'joined', orderBy: { displayOrder: QueryOrder.ASC_NULLS_LAST, createdAt: QueryOrder.DESC }, limit: 40 })).map((i) => i.id),
      q3: async (id) => (await em().find(Message, { userId: id }, { fields: ['id', 'type', 'title', 'isRead', 'createdAt'], orderBy: { createdAt: QueryOrder.DESC }, limit: 20 })).map((x) => x.id),
      q4: (id) => em().count(Link, { status: 'accepted', $or: [{ userId: id }, { otherId: id }] }),
      close: () => orm.close(),
    };
  }
  throw new Error(`unknown side ${name}`);
}
