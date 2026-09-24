import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

test('Electron starts once after valid compilation and restarts only after valid rebuilds', { timeout: 20_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ash-electron-')));
  const desktop = join(root, 'app-ts');
  for (const directory of ['build/app_ts/launch', 'app-ts/node_modules/typescript/bin', 'app-ts/node_modules/electron']) {
    await mkdir(join(root, directory), { recursive: true });
  }
  for (const name of ['build/app_ts/launch/electron.ts', 'build/app_ts/host.ts', 'build/app_ts/paths.ts']) {
    await copyFile(resolve(import.meta.dirname, '../../..', name), join(root, name));
  }
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(desktop, 'package.json'), '{"main":"fixture.cjs"}');
  await writeFile(join(desktop, 'node_modules/electron/index.js'), 'module.exports = process.execPath;');
  await writeFile(join(desktop, 'fixture.cjs'), `
    require('node:fs').appendFileSync('launches.log', JSON.stringify({ pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2), runAsNode: process.env.ELECTRON_RUN_AS_NODE }) + '\\n');
    setInterval(() => {}, 1000);
  `);
  await writeFile(join(desktop, 'node_modules/typescript/bin/tsc'), `
    const fs = require('node:fs');
    const path = require('node:path');
    fs.appendFileSync('compilers.log', JSON.stringify({ pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
    let previous;
    setInterval(() => {
      const phase = fs.readFileSync('phase', 'utf8');
      if (phase === 'stop') process.exit(0);
      if (phase === previous) return;
      console.log(previous === undefined ? 'Starting compilation in watch mode' : 'File change detected. Starting incremental compilation');
      previous = phase;
      const output = '../.build/app-ts/preload/src/ash/base/parts/sandbox/electron-browser/preload.cjs';
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, phase === 'initial' || phase === 'invalid' ? "require('fs')" : "require('electron')");
      console.log('Found ' + (phase === 'error' ? 1 : 0) + ' errors. Watching for file changes.');
      fs.appendFileSync('phases.log', phase + '\\n');
    }, 25);
  `);
  await writeFile(join(desktop, 'phase'), 'initial');
  const child = spawn(process.execPath, [join(root, 'build/app_ts/launch/electron.ts'), '--watch', '--fixture'], {
    cwd: tmpdir(), windowsHide: true, stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const closed = new Promise(resolvePromise => child.once('close', resolvePromise));
  t.after(async () => {
    await writeFile(join(desktop, 'phase'), 'stop');
    await closed;
    await rm(root, { recursive: true, force: true });
  });
  async function lines(file: string): Promise<string[]> {
    const text = await readFile(join(desktop, file), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    return text.trim().split('\n').filter(Boolean);
  }
  async function until(predicate: () => Promise<boolean> | boolean): Promise<void> {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (await predicate()) return;
      assert.equal(child.exitCode, null, output);
      await delay(50);
    }
    assert.fail(output);
  }
  await until(() => output.includes('unsupported runtime imports: fs'));
  assert.deepEqual(await lines('launches.log'), []);
  await writeFile(join(desktop, 'phase'), 'valid');
  await until(async () => (await lines('launches.log')).length === 1);
  const compilers = (await lines('compilers.log')).map(line => JSON.parse(line));
  assert.equal(compilers.length, 1);
  for (const compiler of compilers) {
    assert.equal(compiler.cwd, desktop);
    assert.ok(compiler.args.includes('--watch'));
    assert.deepEqual(compiler.args.slice(0, 3), ['--build', 'tsconfig.main.json', 'tsconfig.preload.json']);
  }
  for (const phase of ['error', 'invalid']) {
    output = '';
    await writeFile(join(desktop, 'phase'), phase);
    await until(async () => (await lines('phases.log')).includes(phase));
    if (phase === 'invalid') await until(() => output.includes('unsupported runtime imports: fs'));
    await delay(300);
    assert.equal((await lines('launches.log')).length, 1);
  }
  await writeFile(join(desktop, 'phase'), 'recovered');
  await until(async () => (await lines('launches.log')).length === 2);
  const launches = (await lines('launches.log')).map(line => JSON.parse(line));
  assert.equal((await lines('compilers.log')).length, 1);
  for (const { pid, ...launch } of launches) {
    assert.ok(pid > 0);
    assert.deepEqual(launch, { cwd: desktop, args: ['--fixture'] });
  }
  await writeFile(join(desktop, 'phase'), 'stop');
  await closed;
  assert.equal(child.exitCode, 1, 'An unexpectedly exited compiler fails the launch task');
  for (const { pid } of [...launches, ...compilers]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
