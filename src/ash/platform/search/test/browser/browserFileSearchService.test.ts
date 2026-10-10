import { strict as assert } from 'node:assert';
import { test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { FileKind } from '../../../files/common/files.js';
import { BrowserFileSearchService } from '../../browser/browserFileSearchService.js';
import { isCancellationError } from '../../../../base/common/errors.js';

const folder = { target: { type: 'workspace' as const, dirId: 'browser-folder' }, resource: URI.file('/@browser/granted') };

test('browser path discovery filters before truncation without reading file contents', async () => {
	const service = new BrowserFileSearchService({
		async readDirectory(directory) {
			const entries: [string, FileKind][] = directory.path === folder.resource.path ? [['root.txt', FileKind.File], ['src', FileKind.Directory]] : [['中文.txt', FileKind.File], ['skip.txt', FileKind.File], ['link.txt', FileKind.SymbolicLink]];
			return entries.map(([name, kind]) => ({ resource: URI.joinPath(directory, name), name, kind }));
		},
	});
	const result = await service.glob(folder, { includePatterns: ['**/*.txt'], excludePatterns: ['**/skip.txt'], maxResults: 1 });
	assert.deepEqual(result.matches.map(item => item.path), ['root.txt']);
	assert.equal(result.totalMatches, 2);
	const nested = await service.glob(folder, { includePatterns: ['src/*.txt'], excludePatterns: ['**/skip.txt'], maxResults: 1 });
	assert.deepEqual(nested.matches.map(item => item.path), ['src/中文.txt']);
});

test('browser path discovery stops a superseded directory scan', async () => {
	const controller = new AbortController();
	let reads = 0;
	const service = new BrowserFileSearchService({
		async readDirectory(directory) {
			reads++;
			controller.abort();
			return [{ resource: URI.joinPath(directory, 'nested'), name: 'nested', kind: FileKind.Directory }];
		},
	});
	await assert.rejects(service.glob(folder, { includePatterns: [], excludePatterns: [], maxResults: 100 }, controller.signal), isCancellationError);
	assert.equal(reads, 1);
});

test('browser fuzzy discovery ranks before truncation and matches case and Unicode', async () => {
	const service = new BrowserFileSearchService({
		async readDirectory(directory) {
			return ['a_l_p_h_a.bin', 'ALPHA.bin', '中文.bin'].map(name => ({ resource: URI.joinPath(directory, name), name, kind: FileKind.File }));
		},
	});
	const result = await service.fuzzy(folder, { query: 'alpha', maxResults: 1 });
	assert.deepEqual(result.matches.map(item => item.path), ['ALPHA.bin']);
	assert.equal(result.totalMatches, 2);
	assert.deepEqual((await service.fuzzy(folder, { query: '中文', maxResults: 1 })).matches.map(item => item.path), ['中文.bin']);
});

test('browser fuzzy discovery skips generated directories and stops cancelled scans', async () => {
	const controller = new AbortController();
	const visited: string[] = [];
	const service = new BrowserFileSearchService({
		async readDirectory(directory) {
			visited.push(directory.path);
			if (directory.path === folder.resource.path) { return ['target', 'src'].map(name => ({ resource: URI.joinPath(directory, name), name, kind: FileKind.Directory })); }
			controller.abort();
			return [{ resource: URI.joinPath(directory, 'late.ts'), name: 'late.ts', kind: FileKind.File }];
		},
	});
	await assert.rejects(service.fuzzy(folder, { query: 'late', maxResults: 1 }, controller.signal), isCancellationError);
	assert.deepEqual(visited, [folder.resource.path, folder.resource.path + '/src']);
});
