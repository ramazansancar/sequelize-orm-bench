// DM8 connection (the password matches DM8_PASSWORD in compose.dm8.yml)
const env = process.env;
const host = env.DM8_HOST || 'localhost';
const port = Number(env.DM8_PORT || 5236);
const password = env.DM8_PASSWORD || 'Bench2026dm8';
export const DM8 = { host, port, user: 'SYSDBA', password, url: `dm://SYSDBA:${encodeURIComponent(password)}@${host}:${port}` };
