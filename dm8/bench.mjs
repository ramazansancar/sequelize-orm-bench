// DM8 (Dameng) vs PostgreSQL 17, library x driver, same four queries and data as the main
// benchmark.   node dm8/bench.mjs <side> [seconds=20] [concurrency=12] [--sql]
// sides on DM8:        dmdb@dm8  sequelize-dm8@dm8  typeorm-dm@dm8  knex-dm@dm8
// sides on PostgreSQL: pg@pg pg-native@pg sequelize5@pg sequelize5-native@pg sequelize6@pg
//                      sequelize6-native@pg typeorm@pg typeorm-native@pg knex@pg knex-native@pg
// (TypeORM is 0.3.31 here, typeorm-dm needs 0.3; sequelize-dm8 is a Sequelize 5 fork, so v5 on pg is
// the like-for-like side.)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { makeSide } from '../lib/sides.mjs';
import { runSide } from '../lib/harness.mjs';
import { defineModels } from '../lib/models.mjs';
import { DB } from '../lib/config.mjs';
import { DM8 } from './config.mjs';

const require = createRequire(import.meta.url);
const ver = (n) => JSON.parse(readFileSync(new URL(`../node_modules/${n}/package.json`, import.meta.url), 'utf8')).version;
const [side, secondsArg, concArg, flag] = process.argv.slice(2);
const conc = Number(concArg) || 12;
const minPool = Math.min(2, conc);
const log = flag === '--sql' ? [] : null;
const flat = (rows) => (rows.length ? { id: rows[0].id, roles: rows.filter((r) => r.key).map((r) => r.key).sort() } : null);

function sequelizeQueries(m, Op) {
  const { User, Role, Item, ItemTranslation, Message, Link } = m;
  const logging = log ? (s) => log.push(s) : false;
  return {
    q1: async (id) => { const u = await User.findByPk(id, { logging, attributes: ['id', 'email', 'username', 'firstName', 'lastName', 'organizationId', 'preferredLanguage'], include: [{ model: Role, as: 'roles', attributes: ['id', 'key', 'name', 'priority'], through: { attributes: [] } }] }); return u ? { id: u.id, roles: u.roles.map((r) => r.key).sort() } : null; },
    q2: async () => (await Item.findAll({ logging, attributes: ['id', 'type', 'isPublic', 'displayOrder', 'createdAt'], where: { isActive: true, isPublic: true }, include: [{ model: ItemTranslation, as: 'translations', attributes: ['name'], where: { language: 'en' }, required: false }], order: [['displayOrder', 'ASC NULLS LAST'], ['createdAt', 'DESC']], limit: 40 })).map((i) => i.id),
    q3: async (id) => (await Message.findAll({ logging, attributes: ['id', 'type', 'title', 'isRead', 'createdAt'], where: { userId: id }, order: [['createdAt', 'DESC']], limit: 20 })).map((x) => x.id),
    q4: async (id) => Number(await Link.count({ logging, where: { status: 'accepted', [Op.or]: [{ userId: id }, { otherId: id }] } })),
  };
}

async function makeDm8Side(lib) {
  if (lib === 'dmdb') {
    const dmdb = require('dmdb');
    const SQL = {
      q1: 'SELECT u."id", r."key" FROM "Users" u LEFT JOIN "UserRoles" ur ON ur."userId" = u."id" AND ur."isActive" = 1 LEFT JOIN "Roles" r ON r."id" = ur."roleId" WHERE u."id" = ?',
      q2: 'SELECT i."id" FROM "Items" i LEFT JOIN "ItemTranslations" t ON t."itemId" = i."id" AND t."language" = \'en\' WHERE i."isActive" = 1 AND i."isPublic" = 1 ORDER BY i."displayOrder" ASC NULLS LAST, i."createdAt" DESC LIMIT 40',
      q3: 'SELECT "id" FROM "Messages" WHERE "userId" = ? ORDER BY "createdAt" DESC LIMIT 20',
      q4: 'SELECT CAST(count(*) AS INT) AS "n" FROM "Links" WHERE "status" = \'accepted\' AND ("userId" = ? OR "otherId" = ?)',
    };
    const pool = await dmdb.createPool({ connectString: `${DM8.url}?autoCommit=true`, poolMax: conc, poolMin: minPool });
    const run = async (q, binds) => { log?.push(SQL[q]); const c = await pool.getConnection(); try { return (await c.execute(SQL[q], binds, { outFormat: dmdb.OUT_FORMAT_OBJECT })).rows; } finally { await c.close(); } };
    return {
      versions: { dmdb: ver('dmdb') },
      q1: async (id) => flat(await run('q1', [id])),
      q2: async () => (await run('q2', [])).map((r) => r.id),
      q3: async (id) => (await run('q3', [id])).map((r) => r.id),
      q4: async (id) => Number((await run('q4', [id, id]))[0].n),
      close: () => pool.close(0),
    };
  }
  if (lib === 'sequelize-dm8') {
    const S = require('sequelize-dm8');
    // sequelize-dm8 opens one dmdb pool per connection, and dmdb >= 1.0.48286 names every pool
    // 'default' and refuses a second one ([20006]). Give each pool its own alias (this process only).
    const dmdb = require('dmdb');
    const createPool = dmdb.createPool.bind(dmdb);
    let poolNo = 0;
    dmdb.createPool = (attrs, ...rest) => createPool({ poolAlias: `sdm8_${++poolNo}`, ...attrs }, ...rest);
    const sequelize = new S.Sequelize({ dialect: 'dmdb', host: DM8.host, port: DM8.port, username: DM8.user, password: DM8.password, logging: false, pool: { max: conc, min: minPool } });
    const m = defineModels(sequelize, { DataTypes: S.DataTypes, Op: S.Op, literal: S.literal });
    return { versions: { 'sequelize-dm8': ver('sequelize-dm8'), dmdb: ver('dmdb') }, ...sequelizeQueries(m, S.Op), close: () => sequelize.close() };
  }
  if (lib === 'typeorm-dm') {
    const { EntitySchema } = require('typeorm');
    const { DmdbDataSource } = require('typeorm-dm');
    const col = (type, extra = {}) => ({ type, ...extra });
    const id = (extra) => col('char', extra);
    const User = new EntitySchema({ name: 'User', tableName: 'Users', columns: { id: id({ primary: true }), email: col('varchar'), username: col('varchar'), firstName: col('varchar'), lastName: col('varchar'), organizationId: id({ nullable: true }), preferredLanguage: col('varchar') }, relations: { userRoles: { type: 'one-to-many', target: 'UserRole', inverseSide: 'user' } } });
    const Role = new EntitySchema({ name: 'Role', tableName: 'Roles', columns: { id: id({ primary: true }), key: col('varchar'), name: col('varchar'), priority: col('int') } });
    const UserRole = new EntitySchema({ name: 'UserRole', tableName: 'UserRoles', columns: { id: id({ primary: true }), userId: id(), roleId: id(), isActive: col('bit') }, relations: { user: { type: 'many-to-one', target: 'User', joinColumn: { name: 'userId' } }, role: { type: 'many-to-one', target: 'Role', joinColumn: { name: 'roleId' } } } });
    const Item = new EntitySchema({ name: 'Item', tableName: 'Items', columns: { id: id({ primary: true }), type: col('varchar'), isPublic: col('bit'), isActive: col('bit'), displayOrder: col('int', { nullable: true }), createdAt: col('timestamp with time zone') }, relations: { translations: { type: 'one-to-many', target: 'ItemTranslation', inverseSide: 'item' } } });
    const ItemTranslation = new EntitySchema({ name: 'ItemTranslation', tableName: 'ItemTranslations', columns: { id: id({ primary: true }), itemId: id(), language: col('varchar'), name: col('varchar') }, relations: { item: { type: 'many-to-one', target: 'Item', joinColumn: { name: 'itemId' } } } });
    const Message = new EntitySchema({ name: 'Message', tableName: 'Messages', columns: { id: id({ primary: true }), userId: id(), type: col('varchar'), title: col('varchar'), isRead: col('bit'), createdAt: col('timestamp with time zone') } });
    const Link = new EntitySchema({ name: 'Link', tableName: 'Links', columns: { id: id({ primary: true }), userId: id(), otherId: id(), status: col('varchar') } });
    const logger = log ? { logQuery: (q) => log.push(q), logQueryError() {}, logQuerySlow() {}, logSchemaBuild() {}, logMigration() {}, log() {} } : undefined;
    const ds = new DmdbDataSource({ type: 'oracle', innerType: 'dmdb', url: `${DM8.url}?schema=SYSDBA`, entities: [User, Role, UserRole, Item, ItemTranslation, Message, Link], synchronize: false, logging: !!log, logger, poolSize: conc, extra: { poolMax: conc, poolMin: minPool } });
    await ds.initialize();
    const users = ds.getRepository('User'); const items = ds.getRepository('Item'); const msgs = ds.getRepository('Message'); const links = ds.getRepository('Link');
    return {
      versions: { typeorm: ver('typeorm'), 'typeorm-dm': ver('typeorm-dm'), dmdb: ver('dmdb') },
      q1: async (uid) => { const u = await users.createQueryBuilder('u').leftJoinAndSelect('u.userRoles', 'ur', 'ur.isActive = :a', { a: 1 }).leftJoinAndSelect('ur.role', 'r').select(['u.id', 'u.email', 'u.username', 'u.firstName', 'u.lastName', 'u.organizationId', 'u.preferredLanguage', 'ur.id', 'r.id', 'r.key', 'r.name', 'r.priority']).where('u.id = :id', { id: uid }).getOne(); return u ? { id: u.id, roles: u.userRoles.map((ur) => ur.role?.key).filter(Boolean).sort() } : null; },
      q2: async () => (await items.createQueryBuilder('i').leftJoinAndSelect('i.translations', 't', 't.language = :l', { l: 'en' }).select(['i.id', 'i.type', 'i.isPublic', 'i.displayOrder', 'i.createdAt', 't.id', 't.name']).where('i.isActive = :a AND i.isPublic = :a', { a: 1 }).orderBy('i.displayOrder', 'ASC', 'NULLS LAST').addOrderBy('i.createdAt', 'DESC').limit(40).getMany()).map((i) => i.id),
      q3: async (uid) => (await msgs.find({ select: { id: true, type: true, title: true, isRead: true, createdAt: true }, where: { userId: uid }, order: { createdAt: 'DESC' }, take: 20 })).map((x) => x.id),
      q4: async (uid) => links.count({ where: [{ status: 'accepted', userId: uid }, { status: 'accepted', otherId: uid }] }),
      close: () => ds.destroy(),
    };
  }
  if (lib === 'knex-dm') {
    const k = require('knex')({ client: require('knex-dm'), connection: { connectString: `${DM8.host}:${DM8.port}`, user: DM8.user, password: DM8.password, schema: 'SYSDBA' }, pool: { min: minPool, max: conc } });
    if (log) k.on('query', (q) => log.push(q.sql));
    return {
      versions: { knex: ver('knex'), 'knex-dm': ver('knex-dm'), dmdb: ver('dmdb') },
      q1: async (id) => flat(await k('Users as u').leftJoin('UserRoles as ur', function () { this.on('ur.userId', '=', 'u.id').andOn('ur.isActive', '=', k.raw('?', [1])); }).leftJoin('Roles as r', 'r.id', 'ur.roleId').select('u.id', 'u.email', 'u.username', 'u.firstName', 'u.lastName', 'u.organizationId', 'u.preferredLanguage', 'r.key', 'r.name', 'r.priority').where('u.id', id)),
      q2: async () => (await k('Items as i').leftJoin('ItemTranslations as t', function () { this.on('t.itemId', '=', 'i.id').andOn('t.language', '=', k.raw('?', ['en'])); }).select('i.id', 'i.type', 'i.isPublic', 'i.displayOrder', 'i.createdAt', 't.name').where('i.isActive', 1).andWhere('i.isPublic', 1).orderByRaw('"i"."displayOrder" asc nulls last').orderBy('i.createdAt', 'desc').limit(40)).map((r) => r.id),
      q3: async (id) => (await k('Messages').select('id', 'type', 'title', 'isRead', 'createdAt').where('userId', id).orderBy('createdAt', 'desc').limit(20)).map((r) => r.id),
      q4: async (id) => Number((await k('Links').count('* as n').where('status', 'accepted').andWhere((qb) => qb.where('userId', id).orWhere('otherId', id)).first()).n),
      close: () => k.destroy(),
    };
  }
  throw new Error(`unknown DM8 side ${lib}`);
}

async function makeSequelize5(lib) {
  const S = require('sequelize5');
  const native = lib.endsWith('-native');
  const C = DB.pg;
  const sequelize = new S.Sequelize(C.database, C.user, C.password, { host: C.host, port: C.port, dialect: 'postgres', native, logging: false, pool: { max: conc, min: minPool } });
  const m = defineModels(sequelize, { DataTypes: S.DataTypes, Op: S.Op, literal: S.literal });
  return { versions: { sequelize: ver('sequelize5'), ...(native ? { 'pg-native': ver('pg-native') } : {}) }, ...sequelizeQueries(m, S.Op), close: () => sequelize.close() };
}

if (!side) { console.error('usage: node dm8/bench.mjs <library>@<pg|dm8> [seconds] [concurrency] [--sql]'); process.exit(2); }
const [lib, db] = side.split('@');
const s = db === 'dm8' ? await makeDm8Side(lib) : lib.startsWith('sequelize5') ? await makeSequelize5(lib) : await makeSide(side, conc, log);
await runSide(side, s, { seconds: Number(secondsArg) || 20, conc, showSql: !!log, sqlLog: log });
process.exit(0);
