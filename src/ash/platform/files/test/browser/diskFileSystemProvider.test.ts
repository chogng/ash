import { Schemas } from '../../../../base/common/network.js';
import { FileUserDataProvider } from '../../../userData/common/fileUserDataProvider.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
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
