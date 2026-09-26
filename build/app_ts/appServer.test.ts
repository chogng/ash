import assert from 'node:assert/strict';
import childProcess, { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';

import { relativeWatchedDirectory, shouldRebuildAppServer, shouldRebuildWorkspaceManifest, watchAppServer } from './appServer.ts';

test('app-server watcher selects Rust sources and Cargo manifests', () => {
  assert.equal(shouldRebuildAppServer('ash-rs/app-server/src/main.rs'), true);
  assert.equal(shouldRebuildAppServer('ash-rs/app-server/build.rs'), true);
  assert.equal(shouldRebuildAppServer('ash-rs/app-server/Cargo.toml'), true);
  assert.equal(shouldRebuildAppServer('Cargo.lock'), true);
  assert.equal(shouldRebuildAppServer('target/debug/ash-app-server'), false);
  assert.equal(shouldRebuildAppServer('target/debug/build/generated/out/schema.rs'), false);
  assert.equal(shouldRebuildAppServer('crate/target/debug/build/generated/out/schema.rs'), false);
  assert.equal(shouldRebuildAppServer('app-ts/src/main.ts'), false);
  assert.equal(shouldRebuildAppServer('app-server-protocol/src/typescript_decoder.template.ts'), true);
  assert.equal(shouldRebuildAppServer('app-server-protocol/src/typescript_web.template.ts'), true);
  assert.equal(shouldRebuildAppServer('app-server-protocol/schema/typescript/index.ts'), false);
});

test('app-server watcher excludes a custom Cargo target directory inside Rust sources', () => {
  const sourceRoot = join('/workspace', 'ash', 'ash-rs');
  const customTarget = join(sourceRoot, '.cargo-cache');
  const ignored = relativeWatchedDirectory(sourceRoot, customTarget);
  assert.equal(ignored, '.cargo-cache');
  assert.equal(shouldRebuildAppServer('.cargo-cache/debug/build/codegen/out/generated.rs', ignored), false);
  assert.equal(shouldRebuildAppServer('app-server/src/main.rs', ignored), true);
  assert.equal(relativeWatchedDirectory(sourceRoot, join('/workspace', 'ash', 'target')), undefined);
});

test('workspace-root watcher accepts only canonical root manifests', () => {
  assert.equal(shouldRebuildWorkspaceManifest('Cargo.toml'), true);
  assert.equal(shouldRebuildWorkspaceManifest('Cargo.lock'), true);
  assert.equal(shouldRebuildWorkspaceManifest('app-rs/main.rs'), false);
  assert.equal(shouldRebuildWorkspaceManifest('target/debug/build/generated/out/schema.rs'), false);
  assert.equal(shouldRebuildWorkspaceManifest('ash-rs/app-server/Cargo.toml'), false);
});

test('watcher stops before the backend build when protocol generation fails', async (t) => {
  const commands: { command: string; args: string[] }[] = [];
  const failure = Promise.withResolvers<string>();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(fs, 'watch', () => ({ close() {} }));
  t.mock.method(console, 'error', (message: string) => failure.resolve(message));
  t.mock.method(childProcess, 'spawn', (_command: string, args: readonly string[]) => {
    commands.push({ command: _command, args: [...args] });
    const child = new ChildProcess();
    setImmediate(() => child.emit('close', 1, null));
    return child;
  });
  syncBuiltinESMExports();
  const stop = await watchAppServer();
  t.after(stop);
  assert.match(await failure.promise, /Protocol generation exited with status 1/);
  assert.deepEqual(commands, [{
    command: process.platform === 'win32' ? 'python' : 'python3',
    args: ['-B', 'build/ash_rs/protocol.py'],
  }]);
});

test('watcher invokes the Python backend builder after protocol synchronization', async (t) => {
  const commands: string[] = [];
  const failure = Promise.withResolvers<string>();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(fs, 'watch', () => ({ close() {} }));
  t.mock.method(console, 'error', (message: string) => failure.resolve(message));
  t.mock.method(childProcess, 'spawn', (_command: string, args: readonly string[]) => {
    commands.push(args.at(-1) ?? '');
    const child = new ChildProcess();
    setImmediate(() => child.emit('close', commands.length === 1 ? 0 : 1, null));
    return child;
  });
  syncBuiltinESMExports();
  const stop = await watchAppServer();
  t.after(stop);
  assert.match(await failure.promise, /backend build exited with status 1/);
  assert.deepEqual(commands, ['build/ash_rs/protocol.py', 'build/ash_rs/develop.py']);
});
