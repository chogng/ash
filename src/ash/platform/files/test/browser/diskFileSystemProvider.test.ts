import { Schemas } from '../../../../base/common/network.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { FileUserDataProvider } from '../../../userData/common/fileUserDataProvider.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { FileNotFoundError, FileRevisionConflictError } from '../../common/files.js';
import { DiskFileSystemProvider } from '../../node/diskFileSystemProvider.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

test('disk file revisions serialize competing saves across window providers', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-file-revision-'));
	try {
		const root = URI.file(directory);
		const resource = URI.joinPath(root, 'user.jsonc');
		using first = new DiskFileSystemProvider([root]);
		using second = new DiskFileSystemProvider([root]);
		const baseline = await first.writeFile(resource, new TextEncoder().encode('// initial\n[]'), { create: true, overwrite: true });
		const results = await Promise.allSettled([
			first.writeFile(resource, new TextEncoder().encode('// first\n[]'), { create: true, overwrite: true, expectedRevision: baseline.revision }),
			second.writeFile(resource, new TextEncoder().encode('// second\n[]'), { create: true, overwrite: true, expectedRevision: baseline.revision }),
		]);
		assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
		const rejected = results.find(result => result.status === 'rejected');
		assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof FileRevisionConflictError);
		assert.match(new TextDecoder().decode((await second.readFile(resource)).bytes), /first|second/u);
		assert.equal((await first.readDirectory(root)).length, 1);
	} finally { await rm(directory, { recursive: true, force: true }); }
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
		await files.writeFile(resource, new TextEncoder().encode('// shortcuts\n[]'), { create: true, overwrite: true });
		await disk.writeFile(URI.joinPath(root, 'workspace/test.json'), new TextEncoder().encode('{}'), { create: true, overwrite: true });
		assert.deepEqual(changes, [[resource.toString()]]);
		assert.deepEqual((await files.readDirectory(profileRoot)).map(entry => entry.resource.toString()), [resource.toString()]);
		assert.equal(new TextDecoder().decode((await files.readFile(resource)).bytes), '// shortcuts\n[]');
		await assert.rejects(files.readFile(resource.with({ path: '/user/../secret.json' })), /current-profile/u);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

suite('Disk provider byte publication and watch disposal', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	(process.platform === 'win32' ? test : test.skip)('an occupied directory rename fails promptly after its child reports ready', async function () {
		this.timeout(15_000);
		const directory = await mkdtemp(join(tmpdir(), 'ash-held-directory-'));
		const folder = join(directory, 'held');
		await mkdir(folder);
		const child = spawn(process.execPath, ['-e', "process.on('disconnect', () => process.exit()); process.send('ready'); setInterval(() => {}, 1000)"], {
			cwd: folder, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
		});
		try {
			await new Promise<void>((resolve, reject) => {
				const cleanup = (): void => { child.off('message', ready); child.off('error', failed); child.off('exit', exited); };
				const ready = (message: unknown): void => { if (message === 'ready') { cleanup(); resolve(); } };
				const failed = (error: Error): void => { cleanup(); reject(error); };
				const exited = (): void => { cleanup(); reject(new Error('Directory holder exited before readiness')); };
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
				if (child.connected) child.disconnect(); else child.kill();
				await exited;
			}
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('a recreated watched root resumes nested changes without publishing its siblings', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-root-watch-'));
		const rootPath = join(directory, 'workspace');
		const root = URI.file(rootPath);
		try {
			await mkdir(rootPath);
			using files = new DiskFileSystemProvider([root]);
			const changes: URI[][] = [];
			const errors: string[] = [];
			using errorListener = files.onDidWatchError(error => errors.push(error));
			using listener = files.onDidChangeFiles(event => changes.push([...(event.resources ?? [])]));
			using watcher = files.watch(root, { recursive: true, excludes: [] });
			const observe = (resource: URI, action: () => Promise<unknown>, retry = false): Promise<void> => new Promise((resolve, reject) => {
				let finished = false;
				const finish = (error?: unknown): void => {
					if (finished) return;
					finished = true;
					clearTimeout(timeout);
					clearInterval(probe);
					change.dispose();
					if (error) reject(error); else resolve();
				};
				const change = files.onDidChangeFiles(event => {
					if (event.resources?.some(item => extUriBiasedIgnorePathCase.isEqual(item, resource))) finish();
				});
				const timeout = setTimeout(() => finish(new Error(`No filesystem change for ${resource.toString()}: ${JSON.stringify({ errors, recent: changes.slice(-5).map(resources => resources.map(item => item.toString())) })}`)), 10_000);
				const run = (): void => { void action().catch(finish); };
				const probe = retry ? setInterval(run, 20) : undefined;
				run();
			});
			const first = join(rootPath, 'ready.txt');
			await observe(URI.file(first), () => writeFile(first, 'ready'), true);
			await observe(root, () => rm(rootPath, { recursive: true }));
			await observe(root, () => mkdir(rootPath));
			const nested = join(rootPath, 'nested');
			await mkdir(nested);
			const restored = join(nested, 'restored.txt');
			await writeFile(join(directory, 'sibling.txt'), 'outside');
			await observe(URI.file(restored), () => writeFile(restored, 'restored'), true);
			watcher.dispose();
			const before = changes.length;
			await writeFile(join(directory, 'sibling.txt'), 'outside');
			await writeFile(restored, 'after disposal');
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(changes.length, before);
			assert.deepEqual(errors, []);
			assert.deepEqual(changes.flat().filter(resource => !extUriBiasedIgnorePathCase.isEqualOrParent(resource, root)).map(resource => resource.toString()), []);
		} finally {
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
			await files.writeFile(resource, new Uint8Array([0, 255]), { create: false, overwrite: true, expectedRevision: initial.revision });
			await assert.rejects(files.writeFile(resource, new Uint8Array([42]), { create: false, overwrite: true, expectedRevision: initial.revision }), FileRevisionConflictError);
			assert.deepEqual(Array.from((await files.readFile(resource)).bytes), [0, 255]);
			assert.deepEqual((await files.readDirectory(root)).map(entry => entry.name), ['bytes.bin']);
		} finally { await rm(directory, { recursive: true, force: true }); }
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
