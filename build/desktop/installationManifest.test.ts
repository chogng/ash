import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeInstallationManifest } from './installationManifest.ts';

test('installation manifest records final bytes, excludes itself and rejects redirected payloads', async () => {
	const root = await mkdtemp(join(tmpdir(), 'ash-install-manifest-'));
	try {
		await mkdir(join(root, 'resources', 'bin'), { recursive: true });
		await writeFile(join(root, 'resources', 'bin', 'helper.exe'), 'signed bytes');
		await writeInstallationManifest(root);
		await writeInstallationManifest(root);
		assert.deepEqual(JSON.parse(await readFile(join(root, 'resources', 'installation-files.json'), 'utf8')), {
			schemaVersion: 1,
			files: { 'resources/bin/helper.exe': createHash('sha256').update('signed bytes').digest('hex') },
		});
		await symlink(
			join(root, 'resources', 'bin'),
			join(root, 'redirect'),
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		await assert.rejects(writeInstallationManifest(root), /unsupported path/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
