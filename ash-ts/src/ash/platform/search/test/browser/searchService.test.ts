import assert from 'node:assert/strict';
import { test } from 'mocha';
import { BrowserContentSearchService } from '../../browser/searchService.js';
import type { IContentSearchApi } from '../../common/searchApi.js';
import type { ContentSearchFreshness } from '../../common/search.js';

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
			requested: freshness ?? 'current', cursors: [0, 100], cancelled: true, count: 150, last: 150,
			result: { resultCount: 150, limitHit: false, error: undefined },
		});
	}
});
