import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [runner, ...extra] = process.argv.slice(2);
assert.ok(extra.length === 0 && (runner === undefined || isAbsolute(runner)),
  'usage: node tests/checkout.mjs [/absolute/path/to/iris]');
const demo = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'iris-checkout-'));
const environment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_MASTER: '1',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(temporary, 'empty-config'),
  GIT_ATTR_NOSYSTEM: '1',
};

function execute(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env: environment, timeout: 120000 });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `${command}: ${result.signal}`);
  return result;
}

function git(cwd, args) {
  const result = execute('git', [
    '-c', `core.attributesFile=${join(temporary, 'empty-config')}`,
    '-c', `core.hooksPath=${join(temporary, 'empty-hooks')}`,
    '-c', 'commit.gpgSign=false', ...args,
  ], cwd);
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

try {
  writeFileSync(join(temporary, 'empty-config'), '');
  mkdirSync(join(temporary, 'empty-hooks'));
  const origin = join(temporary, 'origin');
  mkdirSync(join(origin, 'src'), { recursive: true });
  git(origin, ['init', '--quiet']);
  git(origin, ['config', 'core.autocrlf', 'false']);

  const paths = ['iris.toml', 'src/http.ir', 'src/main.ir'];
  const lock = git(demo, ['show', 'HEAD:iris.lock']);
  const rootPackage = lock.toString('utf8').split('[[packages]]').at(-1);
  assert.match(rootPackage, /^package_id = "org\.iris\.http-server"$/m);
  const fileTable = rootPackage.split('[packages.files]')[1];
  assert.ok(fileTable, 'demo lock must contain the root file hashes');
  const hashes = new Map(fileTable.trim().split(/\r?\n/).map(line => {
    const entry = /^("[^"]+") = "([a-f0-9]{64})"$/.exec(line);
    assert.ok(entry, `unexpected root file entry: ${line}`);
    return [JSON.parse(entry[1]), entry[2]];
  }));
  assert.deepEqual([...hashes.keys()], paths);

  for (const path of paths) {
    const bytes = git(demo, ['show', `HEAD:${path}`]);
    assert.equal(digest(bytes), hashes.get(path), `trusted Git blob must match lock: ${path}`);
    writeFileSync(join(origin, path), bytes);
  }
  writeFileSync(join(origin, 'iris.lock'), lock);
  const policy = join(demo, '.gitattributes');
  if (existsSync(policy)) writeFileSync(join(origin, '.gitattributes'), readFileSync(policy));
  git(origin, ['add', '.']);
  git(origin, ['-c', 'user.name=Checkout Test', '-c', 'user.email=checkout@example.invalid',
    'commit', '--quiet', '-m', 'Seed trusted checkout fixture']);

  for (const autocrlf of ['true', 'false']) {
    const checkout = join(temporary, `checkout-${autocrlf}`);
    console.log(`Given trusted demo blobs and policy; When Git clones with core.autocrlf=${autocrlf}`);
    git(temporary, ['clone', '--quiet', '--no-local', '-c', `core.autocrlf=${autocrlf}`, origin, checkout]);
    const eol = git(checkout, ['ls-files', '--eol', '--', ...paths, 'iris.lock']).toString();
    console.log(eol.trim());
    for (const path of paths) {
      assert.equal(digest(readFileSync(join(checkout, path))), hashes.get(path),
        `Then checkout bytes match iris.lock: autocrlf=${autocrlf} ${path}\n${eol}`);
    }
    const checkedOutLock = readFileSync(join(checkout, 'iris.lock'));
    if (runner) {
      const installed = execute(runner, ['package', 'install', checkout], temporary);
      assert.equal(installed.status, 0, installed.stderr.toString());
      console.log(installed.stdout.toString().trim());
    }

    const source = join(checkout, 'src/http.ir');
    const tampered = readFileSync(source);
    tampered[0] ^= 1;
    writeFileSync(source, tampered);
    assert.notEqual(digest(readFileSync(source)), hashes.get('src/http.ir'),
      'Then a one-byte source edit breaks the locked digest');
    if (runner) {
      const rejected = execute(runner, ['package', 'install', checkout], temporary);
      assert.equal(rejected.status, 1, rejected.stderr.toString());
      assert.match(rejected.stderr.toString(), /package integrity mismatch:/);
      console.log(`Then install refuses a one-byte source edit: ${rejected.stderr.toString().trim()}`);
    }
    assert.deepEqual(readFileSync(join(checkout, 'iris.lock')), checkedOutLock,
      'checkout checks and installs must preserve the existing lock');
    console.log(`PASS core.autocrlf=${autocrlf}: exact locked hashes and tamper detection`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
