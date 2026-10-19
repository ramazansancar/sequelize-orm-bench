// Connection settings for every database, from the environment. Defaults work for a host run
// against `docker compose up -d postgres` (PostgreSQL on localhost:5440); the compose files set the
// service names instead.
const env = process.env;
export const DB = {
  pg: { host: env.PGHOST || 'localhost', port: Number(env.PGPORT || 5440), user: env.PGUSER || 'bench', password: env.PGPASSWORD || 'bench', database: env.PGDATABASE || 'bench' },
  crdb: { host: env.CRDB_HOST || 'localhost', port: Number(env.CRDB_PORT || 26257), user: 'root', password: undefined, database: 'defaultdb' },
  yb: { host: env.YB_HOST || 'localhost', port: Number(env.YB_PORT || 5433), user: 'yugabyte', password: 'yugabyte', database: 'yugabyte' },
  ch: { url: env.CH_URL || 'http://localhost:8123', username: env.CH_USER || 'bench', password: env.CH_PASSWORD || 'bench', database: env.CH_DB || 'bench' },
};
export const pgUrl = (c) => `postgres://${encodeURIComponent(c.user)}${c.password ? `:${encodeURIComponent(c.password)}` : ''}@${c.host}:${c.port}/${c.database}`;
