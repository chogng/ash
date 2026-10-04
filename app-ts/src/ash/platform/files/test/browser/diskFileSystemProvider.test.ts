import { Schemas } from '../../../../base/common/network.js';
import { FileUserDataProvider } from '../../../userData/common/fileUserDataProvider.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { FileRevisionConflictError } from '../../common/files.js';
import { DiskFileSystemProvider } from '../../node/diskFileSystemProvider.js';

test('disk file revisions serialize competing saves across window providers', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-file-revision-'));
	try {
		const root = URI.file(directory);
		const resource = URI.joinPath(root, 'user.jsonc');
		using first = new DiskFileSystemProvider([root]);
		using second = new DiskFileSystemProvider([root]);
		const baseline = await first.writeFile({ resource, content: '// initial\n[]' });
		const results = await Promise.allSettled([
			first.writeFile({ resource, content: '// first\n[]', expectedRevision: baseline.revision }),
			second.writeFile({ resource, content: '// second\n[]', expectedRevision: baseline.revision }),
		]);
		assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
		const rejected = results.find(result => result.status === 'rejected');
		assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof FileRevisionConflictError);
		assert.match((await second.readFile(resource)).content, /first|second/u);
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
		await files.writeFile({ resource, content: '// shortcuts\n[]' });
		await disk.writeFile({ resource: URI.joinPath(root, 'workspace/test.json'), content: '{}' });
		assert.deepEqual(changes, [[resource.toString()]]);
		assert.deepEqual((await files.readDirectory(profileRoot)).map(entry => entry.resource.toString()), [resource.toString()]);
		assert.equal((await files.readFile(resource)).content, '// shortcuts\n[]');
		await assert.rejects(files.readFile(resource.with({ path: '/user/../secret.json' })), /current-profile/u);
	} finally { await rm(directory, { recursive: true, force: true }); }
});
