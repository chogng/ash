import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('compile prepares outputs and stops before bundling when TypeScript or preload validation fails', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ash-compile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['build/app_ts', 'build/lib', 'build/node_modules/vite/bin', 'app-ts/node_modules/typescript/bin']) {
    await mkdir(join(root, directory), { recursive: true });
  }
  for (const file of ['build/app_ts/compile.ts', 'build/app_ts/compilation.ts', 'build/lib/paths.ts']) {
    await copyFile(resolve(import.meta.dirname, '../..', file), join(root, file));
  }
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'app-ts/node_modules/typescript/bin/tsc'), `
    const fs = require('node:fs');
    const path = require('node:path');
    const project = process.argv[process.argv.indexOf('-p') + 1];
    fs.appendFileSync('operations.log', project + '\\n');
    if (process.env.FAILURE === 'typescript') process.exit(1);
    if (project === 'tsconfig.preload.json') {
      const output = '../.build/app-ts/preload/src/ash/base/parts/sandbox/electron-browser/preload.cjs';
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, process.env.FAILURE === 'preload' ? "require('fs')" : "require('electron')");
    }
  `);
  await writeFile(join(root, 'build/node_modules/vite/bin/vite.js'), "require('node:fs').appendFileSync('operations.log', 'bundle\\n');");
  for (const [failure, expected] of [
    ['typescript', ['tsconfig.main.json']],
    ['preload', ['tsconfig.main.json', 'tsconfig.preload.json']],
    ['', ['tsconfig.main.json', 'tsconfig.preload.json', 'tsconfig.renderer.json', 'bundle']],
  ] as const) {
    await writeFile(join(root, 'app-ts/operations.log'), '');
    const result = spawnSync(process.execPath, [join(root, 'build/app_ts/compile.ts'), 'main', 'preload', 'renderer'], {
      cwd: tmpdir(), env: { ...process.env, FAILURE: failure }, encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, failure ? 1 : 0, result.stdout + result.stderr);
    assert.deepEqual((await readFile(join(root, 'app-ts/operations.log'), 'utf8')).trim().split('\n'), expected);
    assert.equal(JSON.parse(await readFile(join(root, '.build/app-ts/package.json'), 'utf8')).type, 'module');
  }
});
