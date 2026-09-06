import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const [runner, ...extra] = process.argv.slice(2);
assert.ok(runner && extra.length === 0, 'usage: node tests/curl.mjs /absolute/path/to/iris');
const demo = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
const startupTimeout = Number(process.env.IRIS_STARTUP_TIMEOUT_MS ?? 60000);
assert.ok(Number.isInteger(startupTimeout) && startupTimeout > 0 && startupTimeout <= 2147483647,
  'IRIS_STARTUP_TIMEOUT_MS must be a positive 32-bit integer');

for (const [engine, flags] of [['reference', []], ['vm', ['--vm']]]) {
  const child = spawn(runner, [
    'package', 'run', demo, '--allow', 'native.load,native.blocking,network.tcp', ...flags,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve([code, signal])));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  let startupTimer;
  let shutdownTimer;
  let ready;
  let startupExit;
  let startupError;
  try {
    try {
      await new Promise((resolve, reject) => {
        startupTimer = setTimeout(() => reject(new Error(`startup timeout: ${stderr}`)), startupTimeout);
        ready = () => {
          if (stdout.includes('http://127.0.0.1:8080')) resolve();
        };
        startupExit = code => reject(new Error(`startup exit ${code}: ${stderr}`));
        startupError = reject;
        child.stdout.on('data', ready);
        child.once('close', startupExit);
        child.once('error', startupError);
      });
    } finally {
      clearTimeout(startupTimer);
      child.stdout.off('data', ready);
      child.off('close', startupExit);
      child.off('error', startupError);
    }
    for (const [method, path, status, body] of [
      ['1GET', '/', '405', 'Method Not Allowed\n'],
      ['GET', '/', '200', 'Hello, Iris!\n'],
      ['GET', '/health', '200', '{"status":"ok"}\n'],
      ['GET', '/missing', '404', 'Not Found\n'],
    ]) {
      const { stdout: output } = await execute('curl', [
        '--silent', '--show-error', '--max-time', '5', '--write-out', '%{http_code}',
        '--request', method,
        `http://127.0.0.1:8080${path}`,
      ]);
      assert.equal(output, body + status);
      console.log(`${engine} curl ${method} ${path}: ${status} ${JSON.stringify(body)}`);
    }
    const [code, signal] = await Promise.race([
      exited,
      new Promise((resolve, reject) => {
        shutdownTimer = setTimeout(() => reject(new Error(`shutdown timeout: ${stderr}`)), 35000);
      }),
    ]);
    assert.equal(code, 0, `${engine}: ${signal}: ${stderr}`);
    console.log(`${engine}: 30-second idle accept clean shutdown PASS`);
  } catch (error) {
    console.error(`${engine} server output: ${stdout}\n${stderr}`);
    throw error;
  } finally {
    clearTimeout(shutdownTimer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  }
}
