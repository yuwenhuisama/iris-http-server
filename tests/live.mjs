import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const [runner, ...extra] = process.argv.slice(2);
assert.ok(runner && extra.length === 0, 'usage: node tests/live.mjs /absolute/path/to/iris');
const demo = fileURLToPath(new URL('../', import.meta.url));
const startupTimeout = Number(process.env.IRIS_STARTUP_TIMEOUT_MS ?? 60000);
assert.ok(Number.isInteger(startupTimeout) && startupTimeout > 0 && startupTimeout <= 2147483647,
  'IRIS_STARTUP_TIMEOUT_MS must be a positive 32-bit integer');

async function exchange(parts, end = true) {
  const socket = net.createConnection({ host: '127.0.0.1', port: 8080 });
  socket.setTimeout(10000, () => socket.destroy(new Error('client timeout')));
  const chunks = [];
  socket.on('data', chunk => chunks.push(chunk));
  const finished = once(socket, 'end');
  try {
    await once(socket, 'connect');
    for (const part of parts) {
      await new Promise((resolve, reject) => socket.write(part, error => error ? reject(error) : resolve()));
    }
    if (end) socket.end();
    try {
      await finished;
    } catch (error) {
      if (error.code !== 'ECONNRESET' || chunks.length === 0) throw error;
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    socket.destroy();
  }
}

function response(actual, status, body) {
  const [headers, actualBody] = actual.split('\r\n\r\n');
  assert.equal(headers.split('\r\n')[0], `HTTP/1.1 ${status}`);
  assert.equal(actualBody, body);
  assert.ok(headers.includes(`Content-Length: ${Buffer.byteLength(body)}\r\n`));
  const ending = status === '405 Method Not Allowed'
    ? 'Connection: close\r\nAllow: GET' : 'Connection: close';
  assert.ok(headers.endsWith(ending));
}

for (const [engine, flags] of [['reference', []], ['vm', ['--vm']]]) {
  const child = spawn(runner, [
    'package', 'run', demo, '--allow', 'native.load,native.blocking,network.tcp', ...flags,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve([code, signal])));
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
    const request = path => `GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`;
    response(await exchange(['1GET / HTTP/1.1\r\nHost: localhost\r\n\r\n']), '405 Method Not Allowed', 'Method Not Allowed\n');
    response(await exchange([request('/')]), '200 OK', 'Hello, Iris!\n');
    response(await exchange(['123 / HTTP/1.1\r\nHost: localhost\r\n\r\n']), '405 Method Not Allowed', 'Method Not Allowed\n');
    response(await exchange(['nil / HTTP/1.1\r\nHost: localhost\r\n\r\n']), '405 Method Not Allowed', 'Method Not Allowed\n');
    response(await exchange(['${raise :injected} / HTTP/1.1\r\nHost: localhost\r\n\r\n']), '400 Bad Request', 'Bad Request\n');
    response(await exchange([request('/')]), '200 OK', 'Hello, Iris!\n');
    response(await exchange([request('/')]), '200 OK', 'Hello, Iris!\n');
    response(await exchange([request('/health')]), '200 OK', '{"status":"ok"}\n');
    response(await exchange([request('/missing')]), '404 Not Found', 'Not Found\n');
    response(await exchange(['GET / HTTP/1.1\r\n\r\n']), '400 Bad Request', 'Bad Request\n');
    response(await exchange([Buffer.from('GET / HTTP/1.1\r\nHost: localhost\r\nX: '), Buffer.from([255]), '\r\n\r\n']), '400 Bad Request', 'Bad Request\n');
    response(await exchange(['GET /heal', 'th HTTP/1.1\r\nHost: localhost\r\n', '\r\n']), '200 OK', '{"status":"ok"}\n');
    response(await exchange([request('/') + request('/health')]), '200 OK', 'Hello, Iris!\n');
    const prefix = 'GET / HTTP/1.1\r\nHost: localhost\r\nX: ';
    response(await exchange([prefix + 'a'.repeat(8192 - prefix.length - 4) + '\r\n\r\n']), '200 OK', 'Hello, Iris!\n');
    response(await exchange([prefix + 'a'.repeat(8192 - prefix.length - 3) + '\r\n\r\n']), '400 Bad Request', 'Bad Request\n');
    response(await exchange(['GET / HTTP/1.1\r\n']), '400 Bad Request', 'Bad Request\n');
    response(await exchange([], false), '400 Bad Request', 'Bad Request\n');
    for (let count = 17; count < 64; count += 1) {
      response(await exchange([request('/health')]), '200 OK', '{"status":"ok"}\n');
    }
    const [code, signal] = await Promise.race([
      exited,
      new Promise((resolve, reject) => {
        shutdownTimer = setTimeout(() => reject(new Error(`shutdown timeout: ${stderr}`)), 35000);
      }),
    ]);
    assert.equal(code, 0, `${engine}: ${signal}: ${stderr}`);
    console.log(`${engine}: 64 clients, digit/source-like methods then GET, routes, malformed/UTF-8, fragments, trailing bytes, limits, EOF, idle timeout, clean shutdown PASS`);
  } catch (error) {
    console.error(`${engine} server output: ${stdout}\n${stderr}`);
    throw error;
  } finally {
    clearTimeout(shutdownTimer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  }
}
