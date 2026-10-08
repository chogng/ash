import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import { BrowserContentSearchService, FileContentSearchService } from '../../browser/searchService.js';
import { FileKind } from '../../../files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import type { ContentSearchMatch } from '../../common/search.js';
import { resetNlsResolver, setNlsMessages } from '../../../../nls.js';
import translatedWorkbench from '../../../../../../localization/zh-CN/workbench.json' with { type: 'json' };
import type { IContentSearchApi } from '../../common/searchApi.js';
import type { ContentSearchFreshness, IContentSearchQuery } from '../../common/search.js';

const query: IContentSearchQuery = {
	text: 'needle', patternKind: 'literal', caseSensitivity: 'sensitive', includePatterns: [], excludePatterns: [],
};

test('browser search explains its empty workspace in the selected display language', async () => {
	setNlsMessages('zh-CN', translatedWorkbench);
	try {
		const service = new FileContentSearchService({
			async readDirectory() { assert.fail('an empty workspace has no directory to read'); },
			async readFileBytes() { assert.fail('an empty workspace has no file to read'); },
		}, { getWorkspace: () => ({ id: 'empty', folders: [] }) });
		assert.deepEqual(await service.search(query), { resultCount: 0, limitHit: false, error: '请打开文件夹以搜索文件。' });
	} finally { resetNlsResolver(); }
});

test('browser file search applies root and nested globs, case, regex, binary exclusion and limits', async () => {
	const root = URI.file('/@browser/granted');
	const bytes = new Map([
		['/main.txt', new TextEncoder().encode('Needle needle\nneedle')],
		['/src/nested.txt', new TextEncoder().encode('needle')],
		['/src/binary.txt', new Uint8Array([0, 110, 101, 101, 100, 108, 101])],
	]);
	const service = new FileContentSearchService({
		async readDirectory(directory) {
			const names = directory.path === root.path ? ['main.txt', 'src'] : ['nested.txt', 'binary.txt'];
			return names.map(name => ({ resource: URI.joinPath(directory, name), name, kind: name === 'src' ? FileKind.Directory : FileKind.File }));
		},
		async readFileBytes(resource) { return { resource, revision: '1', bytes: bytes.get(resource.path.slice(root.path.length))! }; },
	}, { getWorkspace: () => ({ id: 'granted', folders: [{ id: 'granted', uri: root, name: 'granted', index: 0 }] }) });
	const progress: ContentSearchMatch[] = [];
	const complete = await service.search({ ...query, text: 'n.eedle|needle', patternKind: 'regex', includePatterns: ['**/*.txt'], excludePatterns: ['src/**'], maxResults: 1 }, { onProgress: matches => progress.push(...matches) });
	assert.deepEqual({ complete, progress }, {
		complete: { resultCount: 1, limitHit: true, error: undefined },
		progress: [{ dirId: 'granted', dirName: 'granted', path: 'main.txt', lineNumber: 1, preview: 'Needle needle', ranges: [{ start: 7, end: 13 }] }],
	});
	const binary = await service.search({ ...query, text: 'NEEDLE', caseSensitivity: 'insensitive', includePatterns: ['src/**'] });
	assert.deepEqual(binary, { resultCount: 1, limitHit: false, error: undefined });
});

test('browser file search stops delivering lines as soon as its caller cancels', async () => {
	const root = URI.file('/@browser/granted');
	const controller = new AbortController();
	let delivered = 0;
	const service = new FileContentSearchService({
		async readDirectory() { return [{ resource: URI.joinPath(root, 'main.txt'), name: 'main.txt', kind: FileKind.File }]; },
		async readFileBytes(resource) { return { resource, revision: '1', bytes: new TextEncoder().encode('needle\nneedle') }; },
	}, { getWorkspace: () => ({ id: 'granted', folders: [{ id: 'granted', uri: root, name: 'granted', index: 0 }] }) });
	await assert.rejects(service.search(query, { signal: controller.signal, onProgress: () => { delivered++; controller.abort(); } }), { name: 'AbortError' });
	assert.equal(delivered, 1);
});

function page(searchId: string): Awaited<ReturnType<IContentSearchApi['read']>> {
	return { searchId, matches: [], nextMatch: 0, completed: true, limitHit: false, error: null };
}

test('browser file search returns complete multiline blocks and respects Unicode word boundaries', async () => {
	const root = URI.file('/@browser/granted');
	const service = new FileContentSearchService({
		async readDirectory() { return [{ resource: URI.joinPath(root, 'main.txt'), name: 'main.txt', kind: FileKind.File }]; },
		async readFileBytes(resource) { return { resource, revision: '1', bytes: new TextEncoder().encode('中文😀 first\r\nsecond end\r\nfirst\nsecond\nneedles needle 中文needle') }; },
	}, { getWorkspace: () => ({ id: 'granted', folders: [{ id: 'granted', uri: root, name: 'granted', index: 0 }] }) });
	const progress: ContentSearchMatch[] = [];
	const complete = await service.search({ ...query, text: 'first\nsecond' }, { onProgress: matches => progress.push(...matches) });
	assert.deepEqual({ complete, progress }, {
		complete: { resultCount: 2, limitHit: false, error: undefined },
		progress: [
			{ dirId: 'granted', dirName: 'granted', path: 'main.txt', lineNumber: 1, preview: '中文😀 first\nsecond end', ranges: [{ start: 5, end: 17 }] },
			{ dirId: 'granted', dirName: 'granted', path: 'main.txt', lineNumber: 3, preview: 'first\nsecond', ranges: [{ start: 0, end: 12 }] },
		],
	});
	const regexMatches: ContentSearchMatch[] = [];
	await service.search({ ...query, text: '(first)\r\n(second)', patternKind: 'regex' }, { onProgress: matches => regexMatches.push(...matches) });
	assert.deepEqual(regexMatches, progress);
	const words: ContentSearchMatch[] = [];
	await service.search({ ...query, wholeWord: true }, { onProgress: matches => words.push(...matches) });
	assert.deepEqual(words[0]!.ranges, [{ start: 8, end: 14 }]);
});

test('content search forwards freshness and reads all result pages before releasing the job', async () => {
	for (const freshness of [undefined, 'indexed'] as const) {
		let requested: ContentSearchFreshness | undefined;
		let cancelled = false;
		const cursors: number[] = [];
		const api: IContentSearchApi = {
			async start(params) {
				requested = params.freshness;
				return { searchId: 'search-1' };
			},
			async read(params) {
				cursors.push(params.afterMatch);
				if (cursors.length === 1) {
					return { ...page(params.searchId), completed: false };
				}
				const nextMatch = Math.min(params.afterMatch + params.maxMatches, 150);
				return {
					searchId: params.searchId,
					matches: Array.from({ length: nextMatch - params.afterMatch }, (_, index) => ({
						path: 'source.rs', lineNumber: params.afterMatch + index + 1, preview: 'needle', ranges: [],
					})),
					nextMatch,
					completed: nextMatch === 150,
					limitHit: false,
					error: null,
					freshness: requested,
				};
			},
			async cancel() {
				cancelled = true;
			},
		};
		const service = new BrowserContentSearchService(api);
		const lines: number[] = [];
		const result = await service.search({
			text: 'needle', patternKind: 'literal', caseSensitivity: 'sensitive',
			includePatterns: [], excludePatterns: [], freshness,
		}, { onProgress: matches => lines.push(...matches.map(match => match.lineNumber)) });
		assert.deepEqual({ requested, cursors, cancelled, count: lines.length, last: lines.at(-1), result }, {
			requested: freshness ?? 'current', cursors: [0, 0, 100], cancelled: true, count: 150, last: 150,
			result: { resultCount: 150, limitHit: false, error: undefined },
		});
	}
});

test('an already cancelled search creates no backend job', async () => {
	const controller = new AbortController();
	controller.abort();
	const api: IContentSearchApi = {
		async start() { assert.fail('cancelled search must not start'); },
		async read() { assert.fail('cancelled search must not read'); },
		async cancel() { assert.fail('there is no job to release'); },
	};
	await assert.rejects(new BrowserContentSearchService(api).search(query, { signal: controller.signal }), { name: 'AbortError' });
});

test('cancelling during job creation releases the returned job without reading it', async () => {
	const controller = new AbortController();
	const started = new DeferredPromise<{ searchId: string; }>();
	const released: string[] = [];
	const api: IContentSearchApi = {
		start() { return started.p; },
		async read() { assert.fail('a cancelled job must not be read'); },
		async cancel(params) { released.push(params.searchId); },
	};
	const pending = new BrowserContentSearchService(api).search(query, { signal: controller.signal });
	const rejected = assert.rejects(pending, { name: 'AbortError' });
	controller.abort();
	await started.complete({ searchId: 'late-job' });
	await rejected;
	assert.deepEqual(released, ['late-job']);
});

test('cancelling a pending start settles promptly and releases its late handle exactly once', async () => {
	const controller = new AbortController();
	const started = new DeferredPromise<{ searchId: string; }>();
	const released: string[] = [];
	let failure: unknown;
	const api: IContentSearchApi = {
		start() { return started.p; },
		async read() { assert.fail('late cancelled handles must not be read'); },
		async cancel(params) { released.push(params.searchId); throw new Error('connection closed during late cleanup'); },
	};
	const pending = new BrowserContentSearchService(api).search(query, { signal: controller.signal });
	const settled = pending.catch(error => { failure = error; });
	try {
		controller.abort();
		// An event-loop turn is a settlement barrier; the start response remains under test control.
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal((failure as Error | undefined)?.name, 'AbortError');
		assert.deepEqual(released, []);
	} finally {
		await started.complete({ searchId: 'late-job' });
		await settled;
	}
	assert.deepEqual(released, ['late-job']);
});

test('a rejected late start keeps the cancellation outcome without releasing an unknown handle', async () => {
	const controller = new AbortController();
	const started = new DeferredPromise<{ searchId: string; }>();
	const api: IContentSearchApi = {
		start() { return started.p; },
		async read() { assert.fail('cancelled search must not read'); },
		async cancel() { assert.fail('failed start created no handle'); },
	};
	const pending = new BrowserContentSearchService(api).search(query, { signal: controller.signal });
	const rejected = assert.rejects(pending, { name: 'AbortError' });
	controller.abort();
	await started.error(new Error('late start failure'));
	await rejected;
});

test('cancelling an in-flight read suppresses its late results and releases the job', async () => {
	const controller = new AbortController();
	const reading = new DeferredPromise<void>();
	const response = new DeferredPromise<Awaited<ReturnType<IContentSearchApi['read']>>>();
	const released: string[] = [];
	const progress: string[] = [];
	const api: IContentSearchApi = {
		async start() { return { searchId: 'cancelled-job' }; },
		read() { void reading.complete(); return response.p; },
		async cancel(params) { released.push(params.searchId); },
	};
	const pending = new BrowserContentSearchService(api).search(query, {
		signal: controller.signal,
		onProgress: matches => progress.push(...matches.map(match => match.preview)),
	});
	const rejected = assert.rejects(pending, { name: 'AbortError' });
	await reading.p;
	controller.abort();
	await rejected;
	assert.deepEqual(released, ['cancelled-job']);
	await response.complete({
		...page('cancelled-job'), nextMatch: 1,
		matches: [{ path: 'source.rs', lineNumber: 1, preview: 'late result', ranges: [] }],
	});
	assert.deepEqual({ released, progress }, { released: ['cancelled-job'], progress: [] });
});

test('a failed read releases its job and retains the original error if cleanup also fails', async () => {
	const failure = new Error('connection lost');
	const released: string[] = [];
	const api: IContentSearchApi = {
		async start() { return { searchId: 'failed-job' }; },
		async read() { throw failure; },
		async cancel(params) { released.push(params.searchId); throw new Error('cleanup failed'); },
	};
	await assert.rejects(new BrowserContentSearchService(api).search(query), error => error === failure);
	assert.deepEqual(released, ['failed-job']);
});

test('a failed start preserves its error without cancelling an unknown job', async () => {
	const failure = new Error('start rejected');
	const api: IContentSearchApi = {
		async start() { throw failure; },
		async read() { assert.fail('start failed'); },
		async cancel() { assert.fail('no job was created'); },
	};
	await assert.rejects(new BrowserContentSearchService(api).search(query), error => error === failure);
});

test('a backend search error is returned and its job is released', async () => {
	const released: string[] = [];
	const api: IContentSearchApi = {
		async start() { return { searchId: 'backend-error' }; },
		async read() { return { ...page('backend-error'), error: 'invalid regular expression' }; },
		async cancel(params) { released.push(params.searchId); },
	};
	const result = await new BrowserContentSearchService(api).search(query);
	assert.deepEqual({ result, released }, {
		result: { resultCount: 0, limitHit: false, error: 'invalid regular expression' }, released: ['backend-error'],
	});
});

test('cancelling one concurrent search leaves the other search and its results intact', async () => {
	const controller = new AbortController();
	const firstRead = new DeferredPromise<void>();
	const firstResponse = new DeferredPromise<Awaited<ReturnType<IContentSearchApi['read']>>>();
	const released: string[] = [];
	const progress: string[] = [];
	const api: IContentSearchApi = {
		async start(params) { return { searchId: params.query }; },
		async read(params) {
			if (params.searchId === 'first') {
				void firstRead.complete();
				return firstResponse.p;
			}
			assert.equal(params.afterMatch, 0);
			return {
				...page('second'), nextMatch: 1,
				matches: [{ path: 'second.rs', lineNumber: 1, preview: 'second result', ranges: [] }],
			};
		},
		async cancel(params) { released.push(params.searchId); },
	};
	const service = new BrowserContentSearchService(api);
	const first = service.search({ ...query, text: 'first' }, { signal: controller.signal });
	const rejected = assert.rejects(first, { name: 'AbortError' });
	await firstRead.p;
	const secondPending = service.search({ ...query, text: 'second' }, {
		onProgress: matches => progress.push(...matches.map(match => match.preview)),
	});
	controller.abort();
	await rejected;
	const second = await secondPending;
	await firstResponse.complete(page('first'));
	assert.deepEqual({ second, progress, released: released.sort() }, {
		second: { resultCount: 1, limitHit: false, error: undefined },
		progress: ['second result'], released: ['first', 'second'],
	});
});
