# sequelize-orm-bench

A small read-path benchmark for Sequelize. It was written while looking into [sequelize#18551](https://github.com/sequelize/sequelize/issues/18551). It runs the same four queries on the same data through Sequelize v6, `@sequelize/core` v7, other Node.js ORMs and query builders, and the plain drivers, on PostgreSQL 17 and a few other databases.

The Sequelize model definitions are shared between v6 and v7 (`lib/models.mjs`), so the only thing that changes between those two sides is the library.

## The queries

Mix: 35 / 25 / 25 / 15 %.

1. `User.findByPk` with a many-to-many include (`roles` through `UserRoles`, with a `through.scope`)
2. `Item.findAll` with a filtered hasMany include (`translations`, `required: false`), a two-column order (`displayOrder ASC NULLS LAST`, `createdAt DESC`) and `limit: 40`
3. `Message.findAll`, where + order + `limit: 20`, no include
4. `Link.count` with an `Op.or`

Every other library runs the closest equivalent in its own API (`lib/sides.mjs`).

## Data

`seed.mjs` creates the tables and fills them with deterministic synthetic data (seeded RNG, the same rows on every database): ~21k users, ~24k user-role rows, 10 roles, 500 items with ~900 translations, 500k messages and 12k links, plus the indexes the queries use.

## Run with Docker only

Each compose file starts the database(s) it needs, builds a runner image (Node.js 24), seeds once and runs its sides. PostgreSQL comes from `docker-compose.yml`, which every file includes; its data volume is shared, so it is seeded only on the first run.

| File | What it compares |
| :--- | :--- |
| `compose.sequelize.yml` | Sequelize v6, `@sequelize/core` v7, plain `pg` |
| `compose.orms.yml` | ORMs and query builders on PostgreSQL, plain `pg` first as the reference |
| `compose.drivers.yml` | `pg` vs `pg-native`, and Sequelize's ORM path vs its raw `sequelize.query()` path |
| `compose.builds.yml` | local Sequelize v7 builds vs the stock release (see below) |
| `compose.databases.yml` | PostgreSQL vs CockroachDB, YugabyteDB, ClickHouse |
| `compose.dm8.yml` | PostgreSQL vs DM8 (Dameng): driver, Sequelize, TypeORM, Knex on each |

```sh
docker compose -f compose.sequelize.yml run --rm bench
```

Defaults: 3 rounds, 20 s per side, 12 queries in flight. Override with environment variables:

```sh
SIDES=sequelize7@pg,pg@pg ROUNDS=5 DURATION=30 CONC=12 docker compose -f compose.sequelize.yml run --rm bench
```

The table goes to stdout, the raw JSON lines to `results/`. `docker compose down` stops the databases; add `-v` to drop the PostgreSQL volume.

## Run on the host

Requires Node.js 22+ and Docker for the database.

```sh
npm install
docker compose up -d postgres  # PostgreSQL 17 on localhost:5440 (user/password/db: bench)
node seed.mjs                  # ~1 minute
node run.mjs                   # sequelize6@pg, sequelize7@pg and pg@pg, 3 rounds, 20 s each, 12 in flight
```

`node run.mjs kysely@pg,pg@pg 3 20 12` picks sides, rounds, seconds and concurrency. `node bench.mjs sequelize7@pg 20 12` runs one side once and prints a JSON line. `node bench.mjs sequelize7@pg 1 1 --sql` prints the SQL each query sends. Connection settings come from `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` (and `CRDB_HOST`, `YB_HOST`, `CH_URL` for the other databases, see `lib/config.mjs`).

## Sides

A side is `<library>@<database>`.

| Database | Sides |
| :--- | :--- |
| `pg` (PostgreSQL 17) | `pg`, `pg-native`, `postgresjs`, `pgpromise`, `databases`, `slonik`, `kysely`, `knex`, `knex-native`, `drizzle`, `orchid`, `zapatos`, `prisma`, `objection`, `typeorm`, `typeorm-native`, `mikroorm`, `sequelize6`, `sequelize6-native`, `sequelize6-raw`, `sequelize7`, `sequelize7-native`, `sequelize7-raw`, `sequelize7:<build>` |
| `crdb` (CockroachDB) | `pg`, `sequelize6` (through `sequelize-cockroachdb`), `typeorm`, `knex`, `drizzle`, `kysely` |
| `yb` (YugabyteDB) | `pg`, `sequelize6`, `typeorm`, `knex`, `drizzle`, `kysely` |
| `ch` (ClickHouse) | `clickhouse` (`@clickhouse/client`), `kysely` (`@founderpath/kysely-clickhouse`) |
| `dm8` (`compose.dm8.yml` only) | `dmdb`, `sequelize-dm8`, `typeorm-dm`, `knex-dm`; on `pg` next to them: `sequelize5`, `sequelize5-native` and TypeORM 0.3.31 |

`-raw` sends the same SQL text as `pg` through `sequelize.query()`. `-native` uses libpq through `pg-native`.

## How it measures

Each side runs in its own process. The sides are interleaved inside every round, and the table shows the median of the rounds. Every side has to print the same fingerprint (a hash of the full results for 30 users plus the whole item list). `run.mjs` warns if the fingerprints differ.

Client CPU per query is `process.cpuUsage()` of the benchmark process divided by the number of queries. With 12 queries in flight the process is CPU-bound, so latency mostly follows CPU per query.

## Testing a local Sequelize build

Build the packages in a Sequelize checkout and pack them into `builds/<name>/`:

```sh
# in the sequelize repo, on the branch you want to measure
yarn build
for p in utils core postgres; do (cd packages/$p && yarn pack -o /path/to/sequelize-orm-bench/builds/my-branch/$p.tgz); done
git rev-parse HEAD > /path/to/sequelize-orm-bench/builds/my-branch/COMMIT
```

Then either `docker compose -f compose.builds.yml run --rm bench`, or on the host:

```sh
node builds.mjs                                 # installs every builds/<name>/
node run.mjs sequelize7@pg,sequelize7:my-branch@pg
```

`sequelize7:*@pg` expands to every installed build, so a branch and its base can be interleaved in one run: `node run.mjs 'sequelize7:main@pg,sequelize7:my-branch@pg'`. The packed packages keep the checkout's version number (e.g. `7.0.0-alpha.48`) and `@sequelize/postgres` pins `@sequelize/core` to that exact version, so `builds.mjs` uses npm `overrides` to keep the dialect on the local core, and stops if it finds a second copy. Compare a branch against a build of its base commit rather than against the npm release; `main` can be far ahead of the last alpha.

## Notes

- Use an otherwise idle machine. Background CPU (antivirus scans, browsers) shows up directly in the numbers.
- On a Windows host (not in a container), `@sequelize/core` 7.0.0-alpha.48 is much slower: `isModelStatic` calls `require('../model')` on every call, and on Windows that goes to the file system each time. In a quick check it was ~400 q/s stock vs ~2,000 q/s with that one call cached. Run it in Linux or a container to compare libraries; on Windows the result mostly measures that call. (The fix is in [sequelize#18234](https://github.com/sequelize/sequelize/pull/18234).)
- `pg` and the other SQL-first sides select only the columns they need to produce the same fingerprint, so they are a ceiling, not an ORM-equivalent query.
- `typeorm@pg` hides `pg.native` from TypeORM, which otherwise switches to `pg-native` by itself whenever it is installed.
- The DM8 image in `compose.dm8.yml` is a third-party build; check it before you use it.
