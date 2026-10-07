import assert from 'node:assert/strict';
import childProcess, { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';

import { prepareAppServer, relativeWatchedDirectory, shouldRebuildAppServer, shouldRebuildWorkspaceManifest, watchAppServer } from './appServer.ts';
import { pythonCommand } from '../python.ts';

for (const javascriptRuntime of ['host-provided-node', 'packaged-node'] as const) {
	for (const succeeds of [true, false]) {
		test(`${javascriptRuntime} startup ${succeeds ? 'waits for preparation before selecting the runtime' : 'rejects failed preparation without selecting an old runtime'}`, async t => {
			const commands: { command: string; args: string[]; }[] = [];
			t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
			t.mock.method(childProcess, 'spawn', (command: string, args: readonly string[]) => {
				commands.push({ command, args: [...args] });
				const child = new ChildProcess();
				setImmediate(() => child.emit('close', succeeds ? 0 : 1, null));
				return child;
			});
			syncBuiltinESMExports();
			const preparation = prepareAppServer(javascriptRuntime);
			if (succeeds) await preparation;
			else await assert.rejects(preparation, /backend preparation exited with status 1/);
			const expected = [pythonCommand(['-B', 'build/runtime/prepare.py', '--javascript-runtime', javascriptRuntime])];
			if (succeeds && javascriptRuntime === 'host-provided-node') expected.push(pythonCommand(['-B', 'build/runtime/develop.py', '--select-prepared']));
			assert.deepEqual(commands, expected);
		});
	}
}

test('app-server watcher selects Rust sources and Cargo manifests', () => {
	assert.equal(shouldRebuildAppServer('crates/app-server/src/main.rs'), true);
	assert.equal(shouldRebuildAppServer('crates/app-server/build.rs'), true);
	assert.equal(shouldRebuildAppServer('crates/app-server/Cargo.toml'), true);
	assert.equal(shouldRebuildAppServer('Cargo.lock'), true);
	assert.equal(shouldRebuildAppServer('target/debug/ash-app-server'), false);
	assert.equal(shouldRebuildAppServer('target/debug/build/generated/out/schema.rs'), false);
	assert.equal(shouldRebuildAppServer('crate/target/debug/build/generated/out/schema.rs'), false);
	assert.equal(shouldRebuildAppServer('src/main.ts'), false);
	assert.equal(shouldRebuildAppServer('app-server-protocol/src/typescript_decoder.template.ts'), true);
	assert.equal(shouldRebuildAppServer('app-server-protocol/src/typescript_web.template.ts'), true);
	assert.equal(shouldRebuildAppServer('app-server-protocol/schema/typescript/index.ts'), false);
});

test('app-server watcher excludes a custom Cargo target directory inside Rust sources', () => {
	const sourceRoot = join('/workspace', 'ash', 'crates');
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
	assert.equal(shouldRebuildAppServer('tui/src/lib.rs'), false);
	assert.equal(shouldRebuildAppServer('terminal/src/lib.rs'), false);
	assert.equal(shouldRebuildWorkspaceManifest('crates/tui/src/lib.rs'), false);
	assert.equal(shouldRebuildWorkspaceManifest('target/debug/build/generated/out/schema.rs'), false);
	assert.equal(shouldRebuildWorkspaceManifest('crates/app-server/Cargo.toml'), false);
});

test('watcher stops before the backend build when protocol generation fails', async (t) => {
	const commands: { command: string; args: string[]; }[] = [];
	const failure = Promise.withResolvers<string>();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	t.mock.method(fs, 'watch', () => ({ close() { } }));
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
	assert.deepEqual(commands, [pythonCommand(['-B', 'build/runtime/protocol.py'])]);
});

test('watcher invokes the Python backend builder after protocol synchronization', async (t) => {
	const commands: string[] = [];
	const failure = Promise.withResolvers<string>();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	t.mock.method(fs, 'watch', () => ({ close() { } }));
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
	assert.deepEqual(commands, ['build/runtime/protocol.py', 'build/runtime/develop.py']);
});

for (const succeeds of [true, false]) {
	test(`Web watcher ${succeeds ? 'selects the backend after a successful build' : 'keeps the backend when compilation fails'}`, async t => {
		const commands: string[][] = [];
		const completed = Promise.withResolvers<void>();
		let reloads = 0;
		t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
		t.mock.method(fs, 'watch', () => ({ close() { } }));
		t.mock.method(console, 'error', (message: string) => {
			assert.match(message, /backend build exited with status 1/);
			completed.resolve();
		});
		t.mock.method(childProcess, 'spawn', (_command: string, args: readonly string[]) => {
			commands.push([...args]);
			const child = new ChildProcess();
			setImmediate(() => child.emit('close', commands.length === 1 || succeeds ? 0 : 1, null));
			return child;
		});
		syncBuiltinESMExports();
		const stop = await watchAppServer({ javascriptRuntime: 'packaged-node', onDidBuild: async () => { reloads++; completed.resolve(); } });
		t.after(stop);
		await completed.promise;
		assert.deepEqual({ commands, reloads }, {
			commands: [pythonCommand(['-B', 'build/runtime/protocol.py']).args, pythonCommand(['-B', 'build/runtime/prepare.py', '--javascript-runtime', 'packaged-node']).args],
			reloads: succeeds ? 1 : 0,
		});
	});
}
