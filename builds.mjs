// Installs local Sequelize v7 builds next to the stock one, so `sequelize7:<name>@pg` sides can be
// interleaved with `sequelize7@pg` in one run.
//   builds/<name>/core.tgz, postgres.tgz, utils.tgz   (yarn pack output of packages/core, postgres, utils)
//   builds/<name>/COMMIT                               (optional: the commit the build was made from)
//   node builds.mjs            installs every builds/<name>/ that has no node_modules yet
//   node builds.mjs --force    reinstalls all of them
// The packed packages keep the version of the checkout (e.g. 7.0.0-alpha.48) and postgres.tgz pins
// @sequelize/core and @sequelize/utils to that exact version, so overrides point both at the local
// tarballs; otherwise npm would pull the registry release under @sequelize/postgres.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const force = process.argv.includes('--force');
const root = new URL('./builds/', import.meta.url);
const pgVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).dependencies.pg;
const names = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
if (!names.length) console.log('no builds/<name>/ folders');
for (const name of names) {
  const dir = new URL(`./${name}/`, root);
  if (!['core.tgz', 'postgres.tgz', 'utils.tgz'].every((f) => existsSync(new URL(f, dir)))) { console.log(`${name}: skipped (needs core.tgz, postgres.tgz, utils.tgz)`); continue; }
  if (existsSync(new URL('node_modules/', dir)) && !force) { console.log(`${name}: already installed`); continue; }
  if (!existsSync(new URL('COMMIT', dir))) writeFileSync(new URL('COMMIT', dir), 'unknown\n');
  const local = { '@sequelize/core': 'file:./core.tgz', '@sequelize/postgres': 'file:./postgres.tgz', '@sequelize/utils': 'file:./utils.tgz' };
  writeFileSync(new URL('package.json', dir), `${JSON.stringify({ name: `build-${name}`, private: true, dependencies: { ...local, pg: pgVersion }, overrides: { '@sequelize/core': '$@sequelize/core', '@sequelize/utils': '$@sequelize/utils' } }, null, 2)}\n`);
  console.log(`${name}: npm install`);
  const cwd = dir.pathname.replace(/^\/([A-Za-z]:)/, '$1');
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  console.log(execFileSync('npm', ['ls', '@sequelize/core', '@sequelize/utils', '--all'], { cwd, encoding: 'utf8', shell: process.platform === 'win32' }).trim());
  // a second copy under @sequelize/postgres would mean the dialect runs on another core
  const nested = ['core', 'utils'].filter((p) => existsSync(new URL(`node_modules/@sequelize/postgres/node_modules/@sequelize/${p}/`, dir)));
  if (nested.length) throw new Error(`${name}: @sequelize/postgres got its own ${nested.join(' + ')}, the overrides did not apply`);
}
