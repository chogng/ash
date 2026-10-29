import { Schemas } from '../../../../base/common/network.js';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs, { type FSWatcher, type WatchEventType } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';
import { DeferredPromise } from '../../../../base/common/async.js';
import { FileUserDataProvider } from '../../../userData/common/fileUserDataProvider.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { FileNotFoundError, FileRevisionConflictError } from '../../common/files.js';
import { DiskFileSystemProvider } from '../../node/diskFileSystemProvider.js';
import { Emitter } from '../../../../base/common/event.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import type { IFileChangeEvent } from '../../common/files.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

test('disk provider isolates native watching while retaining writes and owning subscription cleanup', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-isolated-watch-'));
	const nativeWatch = mock.method(fs, 'watch', () => {
		throw new Error('Native watcher reached the host loop');
	});
	syncBuiltinESMExports();
	try {
		const root = URI.file(directory);
		const file = URI.joinPath(root, 'settings.json');
		using changes = new Emitter<IFileChangeEvent>();
		const subscriptions: string[] = [];
		const disposed: string[] = [];
		using disk = new DiskFileSystemProvider([root], {
			onDidChangeFiles: changes.event,
			watch(resource, options) {
				assert.deepEqual(options, { recursive: false, excludes: [] });
				subscriptions.push(resource.toString());
				return toDisposable(() => disposed.push(resource.toString()));
			},
		});
		const delivered: string[][] = [];
		using listener = disk.onDidChangeFiles(event => delivered.push(event.resources?.map(resource => resource.toString()) ?? []));
		const watch = disk.watch(file, { recursive: false, excludes: [] });
		assert.deepEqual(subscriptions, [file.toString()]);
		changes.fire({ resources: [file] });
		assert.deepEqual(delivered, [[file.toString()]]);
		await disk.writeFile(file, new TextEncoder().encode('{"saved":true}'), { create: true, overwrite: true });
		assert.equal(new TextDecoder().decode((await disk.readFile(file)).bytes), '{"saved":true}');
		watch.dispose();
		assert.deepEqual(disposed, [file.toString()]);
		disk.watch(root, { recursive: false, excludes: [] });
		disk.dispose();
		assert.deepEqual(disposed, [file.toString(), root.toString()]);
		assert.equal(nativeWatch.mock.calls.length, 0);
	} finally {
		nativeWatch.mock.restore();
		syncBuiltinESMExports();
		await rm(directory, { recursive: true, force: true });
	}
});

test('disk file revisions serialize competing saves across window providers', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-file-revision-'));
	try {
		const root = URI.file(directory);
		const resource = URI.joinPath(root, 'user.jsonc');
		using first = new DiskFileSystemProvider([root]);
		using second = new DiskFileSystemProvider([root]);
		const baseline = await first.writeFile(resource, new TextEncoder().encode('// initial\n[]'), {
			create: true,
			overwrite: true,
		});
		const results = await Promise.allSettled([
			first.writeFile(resource, new TextEncoder().encode('// first\n[]'), {
				create: true,
				overwrite: true,
				expectedRevision: baseline.revision,
			}),
			second.writeFile(resource, new TextEncoder().encode('// second\n[]'), {
				create: true,
				overwrite: true,
				expectedRevision: baseline.revision,
			}),
		]);
		assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
		const rejected = results.find(result => result.status === 'rejected');
		assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof FileRevisionConflictError);
		assert.match(new TextDecoder().decode((await second.readFile(resource)).bytes), /first|second/u);
		assert.equal((await first.readDirectory(root)).length, 1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('profile files map root, content and exact changes while ignoring workspace writes', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-profile-files-'));
	try {
		const root = URI.file(directory);
		const home = URI.joinPath(root, 'profile');
		using disk = new DiskFileSystemProvider([root]);
		await disk.createDirectory(home);
		using files = new FileUserDataProvider(disk, home);
		const profileRoot = URI.from({ scheme: Schemas.vscodeUserData, path: '/user' });
		const resource = URI.joinPath(profileRoot, 'keybindings.json');
		const changes: Array<readonly string[] | undefined> = [];
		using listener = files.onDidChangeFiles(event => changes.push(event.resources?.map(resource => resource.toString())));
		await files.writeFile(resource, new TextEncoder().encode('// shortcuts\n[]'), {
			create: true,
			overwrite: true,
		});
		await disk.writeFile(URI.joinPath(root, 'workspace/test.json'), new TextEncoder().encode('{}'), {
			create: true,
			overwrite: true,
		});
		assert.deepEqual(changes, [[resource.toString()]]);
		assert.deepEqual(
			(await files.readDirectory(profileRoot)).map(entry => entry.resource.toString()),
			[resource.toString()],
		);
		assert.equal(new TextDecoder().decode((await files.readFile(resource)).bytes), '// shortcuts\n[]');
		await assert.rejects(files.readFile(resource.with({ path: '/user/../secret.json' })), /current-profile/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

suite('Disk provider byte publication and watch disposal', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('watch registration invalidates a read made before native notifications become active', async () => {
		const directory = await realpath(await mkdtemp(join(tmpdir(), 'ash-watch-startup-')));
		const path = join(directory, 'settings.json');
		await writeFile(path, 'before');
		const handles: Array<EventEmitter & { closed: boolean; close(): void }> = [];
		const patched = mock.method(fs, 'watch', (watchedPath => {
			// Change the file in the unobserved registration gap; deliver no OS hint.
			if (String(watchedPath) === path) fs.writeFileSync(path, 'during registration');
			const handle = Object.assign(new EventEmitter(), {
				closed: false,
				close() {
					this.closed = true;
				},
			});
			handles.push(handle);
			return handle as unknown as FSWatcher;
		}) as typeof fs.watch);
		syncBuiltinESMExports();
		try {
			using files = new DiskFileSystemProvider([URI.file(directory)]);
			const resource = URI.file(path);
			assert.equal(new TextDecoder().decode((await files.readFile(resource)).bytes), 'before');
			const changed = new DeferredPromise<void>();
			using listener = files.onDidChangeFiles(event => {
				if (event.resources?.some(item => item.toString() === resource.toString())) void changed.complete();
			});
			using watcher = files.watch(resource, { recursive: false, excludes: [] });
			await changed.p;
			assert.equal(new TextDecoder().decode((await files.readFile(resource)).bytes), 'during registration');
			watcher.dispose();
			assert.ok(handles.every(handle => handle.closed && handle.listenerCount('error') === 0));
		} finally {
			patched.mock.restore();
			syncBuiltinESMExports();
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('file watches bind newly created files, survive atomic replacement and preserve the granted path spelling', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-file-watch-'));
		try {
			const physical = join(directory, 'physical');
			const alias = join(directory, 'alias');
			await mkdir(join(physical, 'profile'), { recursive: true });
			await symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
			const root = URI.file(join(alias, 'profile'));
			const resource = URI.joinPath(root, 'settings.json');
			using files = new DiskFileSystemProvider([root]);
			const errors: string[] = [];
			const changes: string[] = [];
			using errorListener = files.onDidWatchError(error => errors.push(error));
			using listener = files.onDidChangeFiles(event => changes.push(...(event.resources?.map(item => item.toString()) ?? [])));
			const watcher = files.watch(resource, { recursive: false, excludes: [] });
			try {
				await files.writeFile(resource, new TextEncoder().encode('created'), {
					create: true,
					overwrite: false,
				});
				const observe = (action: () => Promise<void>, probeReadiness = false): Promise<void> =>
					new Promise((resolve, reject) => {
						let finished = false;
						let observed = false;
						let writing = false;
						const finish = (error?: unknown): void => {
							if (finished) return;
							finished = true;
							clearTimeout(deadline);
							clearInterval(probe);
							event.dispose();
							if (error) reject(error);
							else resolve();
						};
						const event = files.onDidChangeFiles(event => {
							if (event.resources?.some(item => item.toString() === resource.toString())) {
								observed = true;
								clearInterval(probe);
								if (!writing) finish();
							}
						});
						const deadline = setTimeout(() => finish(new Error(`No exact-file notification: ${JSON.stringify({ errors, changes })}`)), 10_000);
						const run = (): void => {
							if (finished || writing) return;
							writing = true;
							void action().then(() => {
								writing = false;
								if (observed) finish();
							}, finish);
						};
						// The native watch binds asynchronously; establish readiness before the one-shot assertions.
						const probe = probeReadiness ? setInterval(run, 20) : undefined;
						run();
					});
				const path = join(physical, 'profile', 'settings.json');
				await observe(() => writeFile(path, 'ready'), true);
				await observe(() => writeFile(path, 'external'));
				const replacement = join(physical, 'profile', 'replacement.json');
				await writeFile(replacement, 'replacement');
				await observe(() => rename(replacement, path));
				await observe(() => writeFile(path, 'rebound'), true);
				await observe(() => writeFile(path, 'after replacement'));
				watcher.dispose();
				const before = changes.length;
				await writeFile(path, 'after disposal');
				await new Promise<void>(resolve => setImmediate(resolve));
				assert.deepEqual(changes.slice(before), []);
				assert.ok(changes.every(change => change === resource.toString()));
				assert.deepEqual(errors, []);
			} finally {
				watcher.dispose();
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	(process.platform === 'win32' ? test : test.skip)('an occupied directory rename fails promptly after its child reports ready', async function () {
		this.timeout(15_000);
		const directory = await mkdtemp(join(tmpdir(), 'ash-held-directory-'));
		const folder = join(directory, 'held');
		await mkdir(folder);
		const child = spawn(process.execPath, ['-e', "process.on('disconnect', () => process.exit()); process.send('ready'); setInterval(() => {}, 1000)"], {
			cwd: folder,
			windowsHide: true,
			stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
		});
		try {
			await new Promise<void>((resolve, reject) => {
				const cleanup = (): void => {
					child.off('message', ready);
					child.off('error', failed);
					child.off('exit', exited);
				};
				const ready = (message: unknown): void => {
					if (message === 'ready') {
						cleanup();
						resolve();
					}
				};
				const failed = (error: Error): void => {
					cleanup();
					reject(error);
				};
				const exited = (): void => {
					cleanup();
					reject(new Error('Directory holder exited before readiness'));
				};
				child.on('message', ready);
				child.once('error', failed);
				child.once('exit', exited);
			});
			using files = new DiskFileSystemProvider([URI.file(directory)]);
			const started = performance.now();
			await assert.rejects(files.rename(URI.file(folder), URI.file(join(directory, 'renamed')), 'error'), /EPERM|EACCES|EBUSY/u);
			assert.ok(performance.now() - started < 10_000, 'A held directory must not use the file retry budget');
		} finally {
			if (child.pid && child.exitCode === null && child.signalCode === null) {
				const exited = once(child, 'exit');
				if (child.connected) child.disconnect();
				else child.kill();
				await exited;
			}
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('directory watches recover without a recreation hint and ignore siblings', async () => {
		const directory = await realpath(await mkdtemp(join(tmpdir(), 'ash-root-watch-')));
		const rootPath = join(directory, 'workspace');
		const root = URI.file(rootPath);
		const handles: NativeWatch[] = [];
		let nextRoot = new DeferredPromise<NativeWatch>();
		class NativeWatch extends EventEmitter {
			readonly closed = new DeferredPromise<void>();
			constructor(
				readonly path: string,
				readonly notify: (event: WatchEventType, filename: string) => void,
			) {
				super();
			}
			close(): void {
				void this.closed.complete();
			}
		}
		// Only control OS hints. Real stat/realpath calls still resolve the directory's
		// replacement inode and the provider still owns every native handle and listener.
		const patched = mock.method(fs, 'watch', ((path, _options, listener) => {
			const handle = new NativeWatch(String(path), listener as fs.WatchListener<string>);
			handles.push(handle);
			if (handle.path === rootPath) void nextRoot.complete(handle);
			return handle as unknown as FSWatcher;
		}) as typeof fs.watch);
		syncBuiltinESMExports();
		try {
			await mkdir(rootPath);
			using files = new DiskFileSystemProvider([root]);
			const changes: string[][] = [];
			const errors: string[] = [];
			using errorListener = files.onDidWatchError(error => errors.push(error));
			using listener = files.onDidChangeFiles(event => changes.push(event.resources?.map(item => item.toString()) ?? []));
			using watcher = files.watch(root, { recursive: true, excludes: [] });
			const first = await nextRoot.p;
			const parent = handles.find(handle => handle.path === directory)!;
			assert.ok(parent);
			first.notify('rename', 'ready.txt');
			assert.deepEqual(changes.pop(), [URI.joinPath(root, 'ready.txt').toString()]);

			await rm(rootPath, { recursive: true });
			first.notify('rename', 'workspace');
			assert.deepEqual(changes.pop(), [root.toString()]);
			await first.closed.p;
			nextRoot = new DeferredPromise<NativeWatch>();
			await mkdir(rootPath);
			// Recreation must recover even when the OS never delivers a parent hint.
			const recreated = await nextRoot.p;
			await mkdir(join(rootPath, 'nested'));
			await writeFile(join(rootPath, 'nested', 'restored.txt'), 'restored');
			recreated.notify('rename', 'nested/restored.txt');
			assert.deepEqual(changes.pop(), [URI.joinPath(root, 'nested/restored.txt').toString()]);

			// Replacement can happen between OS callbacks, with no observed missing state.
			await rename(rootPath, join(directory, 'retired'));
			await mkdir(rootPath);
			nextRoot = new DeferredPromise<NativeWatch>();
			recreated.emit('error', Object.assign(new Error('The retired directory is no longer watchable'), { code: 'EPERM' }));
			const replacement = await nextRoot.p;
			assert.equal(recreated.closed.isSettled, true);
			replacement.notify('rename', 'after-replacement.txt');
			assert.deepEqual(changes.pop(), [URI.joinPath(root, 'after-replacement.txt').toString()]);
			const before = changes.length;
			parent.notify('rename', 'sibling.txt');
			first.notify('rename', 'retired-event.txt');
			recreated.notify('rename', 'retired-event.txt');
			assert.equal(changes.length, before);
			watcher.dispose();
			parent.notify('rename', 'workspace');
			replacement.notify('rename', 'after-disposal.txt');
			assert.equal(changes.length, before);
			assert.ok(handles.every(handle => handle.closed.isSettled && handle.listenerCount('error') === 0));
			assert.deepEqual(errors, []);
			assert.ok(changes.flat().every(value => extUriBiasedIgnorePathCase.isEqualOrParent(URI.parse(value), root)));
		} finally {
			patched.mock.restore();
			syncBuiltinESMExports();
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('exclusive creation preserves empty files and replacement requires an existing file', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-file-modes-'));
		try {
			const root = URI.file(directory);
			using files = new DiskFileSystemProvider([root]);
			const resource = URI.joinPath(root, 'bytes.bin');
			await assert.rejects(files.writeFile(resource, new Uint8Array([255]), { create: false, overwrite: true }), FileNotFoundError);
			await files.writeFile(resource, new Uint8Array(), { create: true, overwrite: false });
			await assert.rejects(files.writeFile(resource, new Uint8Array([255]), { create: true, overwrite: false }), /already exists/);
			assert.deepEqual(Array.from((await files.readFile(resource)).bytes), []);
			const initial = await files.readFile(resource);
			await files.writeFile(resource, new Uint8Array([0, 255]), {
				create: false,
				overwrite: true,
				expectedRevision: initial.revision,
			});
			await assert.rejects(
				files.writeFile(resource, new Uint8Array([42]), {
					create: false,
					overwrite: true,
					expectedRevision: initial.revision,
				}),
				FileRevisionConflictError,
			);
			assert.deepEqual(Array.from((await files.readFile(resource)).bytes), [0, 255]);
			assert.deepEqual(
				(await files.readDirectory(root)).map(entry => entry.name),
				['bytes.bin'],
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('disposing a watch before initialization suppresses late errors and releases its resources', async () => {
		using files = new DiskFileSystemProvider([URI.file('/granted')]);
		const errors: string[] = [];
		using listener = files.onDidWatchError(error => errors.push(error));
		using watch = files.watch(URI.file('/outside'), { recursive: true, excludes: [] });
		watch.dispose();
		// The rejected path check settles in the microtask queue before the next event-loop turn.
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(errors, []);
	});
});
