import assert from 'node:assert/strict';
import childProcess, { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';

import { prepareAppServer, relativeWatchedDirectory, shouldRebuildAppServer, shouldRebuildWorkspaceManifest, watchAppServer } from './appServer.ts';
import { pythonCommand } from '../python.ts';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const protocolDirectories = ['app-server-protocol', 'protocol', 'queue-contract'].map(name => join(repositoryRoot, 'crates', name));

function mockProtocolDirectories(t: TestContext, directories = () => protocolDirectories) {
	return t.mock.method(childProcess, 'execFile', (_command: string, args: readonly string[], _options: object, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
		assert.deepEqual(args, pythonCommand(['-B', 'build/protocol/generate.py', '--source-directories']).args);
		setImmediate(() => callback(null, JSON.stringify(directories()), ''));
		return new ChildProcess();
	});
}

function mockSourceChanges(t: TestContext) {
	const listeners = new Map<string, (event: string, file: string) => void>();
	t.mock.method(fs, 'watch', (...args: unknown[]) => {
		listeners.set(args[0] as string, args.at(-1) as (event: string, file: string) => void);
		return { close() { } };
	});
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	return (file: string, workspaceManifest = false) => {
		const directory = workspaceManifest ? repositoryRoot : join(repositoryRoot, 'crates');
		listeners.get(directory)!('change', file);
	};
}

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
			const expected = [pythonCommand(['-B', 'build/prepare.py', '--javascript-runtime', javascriptRuntime])];
			if (succeeds && javascriptRuntime === 'host-provided-node') expected.push(pythonCommand(['-B', 'build/desktop/develop.py', '--select-prepared']));
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
	assert.equal(shouldRebuildAppServer('../.build/protocol/typescript/index.ts'), false);
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
	mockProtocolDirectories(t);
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
	assert.deepEqual(commands, [pythonCommand(['-B', 'build/protocol/generate.py'])]);
});

test('watcher invokes the Python backend builder after protocol generation', async (t) => {
	const commands: string[] = [];
	const failure = Promise.withResolvers<string>();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	mockProtocolDirectories(t);
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
	assert.deepEqual(commands, ['build/protocol/generate.py', 'build/desktop/develop.py']);
});

for (const succeeds of [true, false]) {
	test(`Web watcher ${succeeds ? 'selects the backend after a successful build' : 'keeps the backend when compilation fails'}`, async t => {
		const commands: string[][] = [];
		const completed = Promise.withResolvers<void>();
		let reloads = 0;
		t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
		mockProtocolDirectories(t);
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
			commands: [pythonCommand(['-B', 'build/protocol/generate.py']).args, pythonCommand(['-B', 'build/prepare.py', '--javascript-runtime', 'packaged-node']).args],
			reloads: succeeds ? 1 : 0,
		});
	});
}

for (const javascriptRuntime of ['host-provided-node', 'packaged-node'] as const) {
	test(`${javascriptRuntime} business saves build the backend without exporting protocols`, async t => {
		const commands: string[][] = [];
		const completed = Promise.withResolvers<void>();
		mockProtocolDirectories(t);
		const save = mockSourceChanges(t);
		t.mock.method(childProcess, 'spawn', (_command: string, args: readonly string[]) => {
			commands.push([...args]);
			const child = new ChildProcess();
			setImmediate(() => child.emit('close', 0, null));
			return child;
		});
		syncBuiltinESMExports();
		const stop = await watchAppServer({ skipInitial: true, javascriptRuntime, onDidBuild: async () => completed.resolve() });
		t.after(stop);
		save('app-server/src/server/operations.rs');
		await completed.promise;
		const expected = javascriptRuntime === 'packaged-node'
			? ['-B', 'build/prepare.py', '--javascript-runtime', 'packaged-node']
			: ['-B', 'build/desktop/develop.py'];
		assert.deepEqual(commands, [pythonCommand(expected).args]);
	});
}

test('a shared contract save survives a later business save in the same batch', async t => {
	const commands: string[] = [];
	const completed = Promise.withResolvers<void>();
	mockProtocolDirectories(t);
	const save = mockSourceChanges(t);
	t.mock.method(childProcess, 'spawn', (_command: string, args: readonly string[]) => {
		commands.push(args.at(-1)!);
		const child = new ChildProcess();
		setImmediate(() => child.emit('close', 0, null));
		return child;
	});
	syncBuiltinESMExports();
	const stop = await watchAppServer({ skipInitial: true, onDidBuild: async () => completed.resolve() });
	t.after(stop);
	save('queue-contract/src/lib.rs');
	save('app-server/src/server/operations.rs');
	await completed.promise;
	assert.deepEqual(commands, ['build/protocol/generate.py', 'build/desktop/develop.py']);
});

test('a protocol save during an active backend build exports before the next build', async t => {
	const commands: string[] = [];
	const firstBuild = Promise.withResolvers<ChildProcess>();
	const completed = Promise.withResolvers<void>();
	let builds = 0;
	mockProtocolDirectories(t);
	const save = mockSourceChanges(t);
	t.mock.method(childProcess, 'spawn', (_command: string, args: readonly string[]) => {
		commands.push(args.at(-1)!);
		const child = new ChildProcess();
		if (commands.length === 1) firstBuild.resolve(child);
		else setImmediate(() => child.emit('close', 0, null));
		return child;
	});
	syncBuiltinESMExports();
	const stop = await watchAppServer({ skipInitial: true, onDidBuild: async () => { if (++builds === 2) completed.resolve(); } });
	t.after(stop);
	save('app-server/src/server/operations.rs');
	const backend = await firstBuild.promise;
	save('protocol/src/lib.rs');
	setTimeout(() => backend.emit('close', 0, null), 300);
	await completed.promise;
	assert.deepEqual(commands, ['build/desktop/develop.py', 'build/protocol/generate.py', 'build/desktop/develop.py']);
});

test('a manifest as the first save exports before building the backend', async t => {
	const commands: string[] = [];
	const completed = Promise.withResolvers<void>();
	mockProtocolDirectories(t);
	const save = mockSourceChanges(t);
	t.mock.method(childProcess, 'spawn', (_command: string, args: readonly string[]) => {
		commands.push(args.at(-1)!);
		const child = new ChildProcess();
		setImmediate(() => child.emit('close', 0, null));
		return child;
	});
	syncBuiltinESMExports();
	const stop = await watchAppServer({ skipInitial: true, onDidBuild: async () => completed.resolve() });
	t.after(stop);
	save('Cargo.lock', true);
	await completed.promise;
	assert.deepEqual(commands, ['build/protocol/generate.py', 'build/desktop/develop.py']);
});

test('failed dependency discovery blocks the backend and is retried on the next save', async t => {
	const commands: string[] = [];
	const failed = Promise.withResolvers<void>();
	const completed = Promise.withResolvers<void>();
	let discoveries = 0;
	const save = mockSourceChanges(t);
	t.mock.method(childProcess, 'execFile', (_command: string, _args: readonly string[], _options: object, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
		const error = ++discoveries === 1 ? new Error('invalid Cargo manifest') : null;
		setImmediate(() => callback(error, JSON.stringify(protocolDirectories), ''));
		return new ChildProcess();
	});
	t.mock.method(console, 'error', () => failed.resolve());
	t.mock.method(childProcess, 'spawn', (_command: string, args: readonly string[]) => {
		commands.push(args.at(-1)!);
		const child = new ChildProcess();
		setImmediate(() => child.emit('close', 0, null));
		return child;
	});
	syncBuiltinESMExports();
	const stop = await watchAppServer({ skipInitial: true, onDidBuild: async () => completed.resolve() });
	t.after(stop);
	save('app-server/src/server/operations.rs');
	await failed.promise;
	assert.deepEqual(commands, []);
	save('app-server/src/server/operations.rs');
	await completed.promise;
	assert.equal(discoveries, 2);
	assert.deepEqual(commands, ['build/protocol/generate.py', 'build/desktop/develop.py']);
});

test('failed protocol export is retried before a subsequent business build', async t => {
	const commands: string[] = [];
	const failed = Promise.withResolvers<void>();
	const completed = Promise.withResolvers<void>();
	mockProtocolDirectories(t);
	const save = mockSourceChanges(t);
	t.mock.method(console, 'error', () => failed.resolve());
	t.mock.method(childProcess, 'spawn', (_command: string, args: readonly string[]) => {
		commands.push(args.at(-1)!);
		const child = new ChildProcess();
		const code = commands.length === 1 ? 1 : 0;
		setImmediate(() => child.emit('close', code, null));
		return child;
	});
	syncBuiltinESMExports();
	const stop = await watchAppServer({ skipInitial: true, onDidBuild: async () => completed.resolve() });
	t.after(stop);
	save('app-server-protocol/src/lib.rs');
	await failed.promise;
	assert.deepEqual(commands, ['build/protocol/generate.py']);
	save('app-server/src/server/operations.rs');
	await completed.promise;
	assert.deepEqual(commands, ['build/protocol/generate.py', 'build/protocol/generate.py', 'build/desktop/develop.py']);
});

test('manifest changes refresh the protocol graph before new dependency saves', async t => {
	const commands: string[] = [];
	let directories = protocolDirectories;
	const discovery = mockProtocolDirectories(t, () => directories);
	const save = mockSourceChanges(t);
	let completed = Promise.withResolvers<void>();
	t.mock.method(childProcess, 'spawn', (_command: string, args: readonly string[]) => {
		commands.push(args.at(-1)!);
		const child = new ChildProcess();
		setImmediate(() => child.emit('close', 0, null));
		return child;
	});
	syncBuiltinESMExports();
	const stop = await watchAppServer({ skipInitial: true, onDidBuild: async () => completed.resolve() });
	t.after(stop);
	save('app-server/src/server/operations.rs');
	await completed.promise;
	completed = Promise.withResolvers<void>();
	directories = [...directories, join(repositoryRoot, 'crates/new-contract')];
	save('Cargo.toml', true);
	await completed.promise;
	completed = Promise.withResolvers<void>();
	save('new-contract/src/lib.rs');
	await completed.promise;
	assert.equal(discovery.mock.callCount(), 2);
	assert.deepEqual(commands, ['build/desktop/develop.py', 'build/protocol/generate.py', 'build/desktop/develop.py', 'build/protocol/generate.py', 'build/desktop/develop.py']);
});
