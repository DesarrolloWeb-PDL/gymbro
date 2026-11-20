/* Where the data directory comes from when the host cannot provide the default one.
 *
 * The default is the compose bind mount (./data:/data). On a read-only root - a serverless
 * container, a minimal image - creating it is impossible, and the process used to die at import
 * with ENOENT before it ever listened. Two rules cover it:
 *
 *   DATA_DIR not set  -> fall back to a temporary directory and boot (the warning says so)
 *   DATA_DIR set      -> throw: a path the operator named and cannot create is their error
 *
 * The first test exercises the default path. On Linux CI the runner cannot create /data, so it
 * takes the fallback and proves it boots; on a developer machine where /data is creatable it takes
 * the happy path. Either way "unset means boot" is what it pins.
 *
 * The second must hold everywhere: an explicit path whose parent is a file cannot be created
 * (ENOTDIR), and the server has to refuse rather than quietly relocate the operator's data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const baseEnv = extra => {
  const env = { ...process.env, PORT: '0', ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' };
  delete env.DATA_DIR;                    // first: extra must be able to set it again below
  Object.assign(env, extra);
  return env;
};

/** Boots server.js and resolves with the port it announced, or rejects with everything it printed. */
function boot(t, env) {
  const child = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'], env });
  t.after(() => child.kill('SIGKILL'));
  let log = '';
  return new Promise((resolve, reject) => {
    const give = setTimeout(() => reject(new Error(`server never announced a port:\n${log}`)), 20000);
    child.stdout.on('data', d => { log += d; const m = /gym-api on :(\d+)/.exec(log); if (m) { clearTimeout(give); resolve({ port: +m[1], log }); } });
    child.stderr.on('data', d => { log += d; });
    child.on('exit', code => { clearTimeout(give); reject(Object.assign(new Error(`server exited (${code})\n${log}`), { code, log })); });
  });
}

test('with DATA_DIR unset the server boots on whatever directory it can create', async t => {
  const { port, log } = await boot(t, baseEnv());
  assert.ok(port > 0, 'no port announced');
  const r = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  // On a host where the default is impossible this is the line that proves the fallback ran; where
  // the default is creatable the server simply uses it. Either way it must not have died.
  assert.doesNotMatch(log, /ENOENT: no such file or directory, mkdir/);
});

test('with DATA_DIR set to an impossible path the server refuses to boot', async t => {
  const blocker = path.join(os.tmpdir(), `gymbro-not-a-dir-${process.pid}-${Date.now()}`);
  fs.writeFileSync(blocker, 'not a directory');
  t.after(() => { try { fs.rmSync(blocker, { force: true }); } catch { /* already gone */ } });

  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: baseEnv({ DATA_DIR: path.join(blocker, 'child') }),
  });
  t.after(() => child.kill('SIGKILL'));

  const result = await new Promise(resolve => {
    let log = '';
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });
    child.on('exit', code => resolve({ code, log }));
    setTimeout(() => resolve({ code: null, log: log + '\n(timeout)' }), 20000);
  });

  assert.notEqual(result.code, 0, `an impossible explicit DATA_DIR must stop the boot, got:\n${result.log}`);
  assert.match(result.log, /mkdir/, `expected a mkdir failure, got:\n${result.log}`);
  assert.match(result.log, /child/, `expected the configured path in the error, got:\n${result.log}`);
});
