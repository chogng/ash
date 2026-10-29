import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { FileKind, FileRevisionConflictError, FileSystemProviderErrorCode, toFileSystemProviderErrorCode } from '../../common/files.js';
import { InMemoryFileSystemProvider } from '../../common/inMemoryFilesystemProvider.js';

suite('InMemoryFileSystemProvider', () => {
	test('stores independent bytes and rejects stale writes without changing content', async () => {
		using files = new InMemoryFileSystemProvider();
		using other = new InMemoryFileSystemProvider();
		const resource = URI.file('/sample/file.ts');
		await files.createDirectory(URI.file('/sample'));
		const bytes = new Uint8Array([1, 2, 3]);
		const saved = await files.writeFile(resource, bytes, { create: true, overwrite: false });
		bytes[0] = 99;
		const read = await files.readFile(resource);
		read.bytes[1] = 99;
		assert.deepEqual((await files.readFile(resource)).bytes, new Uint8Array([1, 2, 3]));
		await assert.rejects(other.readFile(resource), error => toFileSystemProviderErrorCode(error as Error) === FileSystemProviderErrorCode.FileNotFound);
		await files.writeFile(resource, new Uint8Array([4]), {
			create: false,
			overwrite: true,
			expectedRevision: saved.revision,
		});
		await assert.rejects(files.writeFile(resource, bytes, { create: false, overwrite: true, expectedRevision: saved.revision }), FileRevisionConflictError);
		assert.deepEqual((await files.readFile(resource)).bytes, new Uint8Array([4]));
	});

	test('copy, rename and delete preserve trees and invalidate the affected resources', async () => {
		using files = new InMemoryFileSystemProvider();
		const folder = URI.file('/sample/src');
		const source = URI.joinPath(folder, 'index.ts');
		await files.createDirectory(folder);
		await files.writeFile(source, new TextEncoder().encode('sample'), { create: true, overwrite: false });
		const recorded: string[][] = [];
		using listener = files.onDidChangeFiles(event => recorded.push(event.resources?.map(uri => uri.path) ?? []));
		const copy = URI.file('/sample/copied');
		await files.copy(folder, copy);
		const moved = URI.file('/sample/moved');
		await files.rename(copy, moved, 'error');
		assert.deepEqual(await files.readDirectory(moved), [{ resource: URI.joinPath(moved, 'index.ts'), name: 'index.ts', kind: FileKind.File }]);
		assert.equal(new TextDecoder().decode((await files.readFile(URI.joinPath(moved, 'index.ts'))).bytes), 'sample');
		await assert.rejects(files.delete(moved, 'error', 'fileOrEmptyDirectory'));
		await files.delete(moved, 'error', 'recursive');
		assert.equal((await files.stat(source)).kind, FileKind.File);
		assert.deepEqual(recorded.slice(0, 2), [
			[folder.path, copy.path],
			[copy.path, moved.path],
		]);
		assert.ok(recorded[2]?.includes('/sample/moved/index.ts'));
		await assert.rejects(files.stat(URI.joinPath(moved, 'index.ts')));
	});

	test('conflicting and overlapping transfers leave the source intact', async () => {
		using files = new InMemoryFileSystemProvider();
		const source = URI.file('/source');
		const target = URI.file('/target');
		await files.createDirectory(source);
		await files.createFile(target, 'error');
		await assert.rejects(files.rename(source, target, 'error'), error => toFileSystemProviderErrorCode(error as Error) === FileSystemProviderErrorCode.FileExists);
		await assert.rejects(files.copy(source, URI.joinPath(source, 'nested')));
		assert.equal((await files.stat(source)).kind, FileKind.Directory);
		assert.equal((await files.stat(target)).kind, FileKind.File);
		files.dispose();
		await assert.rejects(files.readFile(target), ReferenceError);
	});
});
