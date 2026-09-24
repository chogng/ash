import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import { BrowserContentSearchService } from '../../browser/searchService.js';
import type { IContentSearchApi } from '../../common/searchApi.js';
import type { ContentSearchFreshness, IContentSearchQuery } from '../../common/search.js';

const query: IContentSearchQuery = {
	text: 'needle', patternKind: 'literal', caseSensitivity: 'sensitive', includePatterns: [], excludePatterns: [],
};

function page(searchId: string): Awaited<ReturnType<IContentSearchApi['read']>> {
	return { searchId, matches: [], nextMatch: 0, completed: true, limitHit: false, error: null };
}

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
	const started = new DeferredPromise<{ searchId: string }>();
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
