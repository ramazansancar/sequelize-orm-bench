# sequelize-orm-bench

A small read-path benchmark for Sequelize. It was written while looking into [sequelize#18551](https://github.com/sequelize/sequelize/issues/18551). It compares Sequelize v6, `@sequelize/core` v7 and plain `pg` on the same four queries and the same data.

The model definitions are shared between v6 and v7 (`models.mjs`), so the only thing that changes between those two sides is the library.

## The queries

Mix: 35 / 25 / 25 / 15 %.

1. `User.findByPk` with a many-to-many include (`roles` through `UserRoles`, with a `through.scope`)
2. `Item.findAll` with a filtered hasMany include (`translations`, `required: false`), a two-column order (`displayOrder ASC NULLS LAST`, `createdAt DESC`) and `limit: 40`
3. `Message.findAll`, where + order + `limit: 20`, no include
4. `Link.count` with an `Op.or`

## Data

`seed.mjs` creates the tables and fills them with deterministic synthetic data (seeded RNG): ~21k users, ~24k user-role rows, 10 roles, 500 items with ~900 translations, 500k messages and 12k links, plus the indexes the queries use.

## Run

Requires Docker and Node.js 22+.

```sh
npm install
docker compose up -d          # PostgreSQL 17 on localhost:5440 (user/password/db: bench)
node seed.mjs                 # ~1 minute
node run.mjs                  # v6, v7 and pg, 3 rounds, 20 s each, 12 queries in flight
```

`node run.mjs v7,pg 3 20 12` picks sides, rounds, seconds and concurrency. `node bench.mjs v7 20 12` runs one side once and prints a JSON line. `node bench.mjs v7 1 1 --sql` prints the SQL each query sends.

Each side runs in its own process. The sides are interleaved inside every round, and the table shows the median of the rounds. Every side has to print the same fingerprint (a hash of the full results for 30 users plus the whole item list). `run.mjs` warns if the fingerprints differ.

Client CPU per query is `process.cpuUsage()` of the benchmark process divided by the number of queries. With 12 queries in flight the process is CPU-bound, so latency mostly follows CPU per query.

## Testing a local Sequelize build

Build the packages in a Sequelize checkout, pack them, and point this project at the tarballs:

```sh
# in the sequelize repo
yarn build
(cd packages/utils && yarn pack -o /tmp/seq/utils.tgz)
(cd packages/core && yarn pack -o /tmp/seq/core.tgz)
(cd packages/postgres && yarn pack -o /tmp/seq/postgres.tgz)

# here
npm install /tmp/seq/utils.tgz /tmp/seq/core.tgz /tmp/seq/postgres.tgz
node run.mjs v7 3 20 12
```

Put the stock `7.0.0-alpha.48` and the local build into two copies of this folder if you want them interleaved in one run.

## Notes

- Use an otherwise idle machine. Background CPU (antivirus scans, browsers) shows up directly in the numbers.
- `pg` selects only the columns it needs to produce the same fingerprint, so it's a ceiling, not an ORM-equivalent query.
