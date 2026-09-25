import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { FileKind, FileRevisionConflictError } from '../../../../../platform/files/common/files.js';
import { DiskFileSystemProvider } from '../../../../../platform/files/node/diskFileSystemProvider.js';

test('Disk file provider detects an external edit before saving', async () => {
	const root = await mkdtemp(join(tmpdir(), 'ash-file-provider-'));
	try {
		const path = join(root, 'main.ts');
		await writeFile(path, 'first', 'utf8');
		using provider = new DiskFileSystemProvider([URI.file(root)]);
		const resource = URI.file(path);
		assert.deepEqual((await provider.readDirectory(URI.file(root))).map(entry => [entry.name, entry.kind]), [['main.ts', FileKind.File]]);
		const original = await provider.readFile(resource);
		await writeFile(path, 'external edit', 'utf8');
		await assert.rejects(
			provider.writeFile({ resource, content: 'editor edit', expectedRevision: original.revision }),
			FileRevisionConflictError,
		);
		assert.equal(await readFile(path, 'utf8'), 'external edit');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
