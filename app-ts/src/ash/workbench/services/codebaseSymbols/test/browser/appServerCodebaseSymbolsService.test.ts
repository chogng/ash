import assert from "node:assert/strict";
import { test } from "mocha";
import type { ICodebaseSymbolsApi } from "../../../../../platform/codebaseSymbols/common/codebaseSymbolsApi.js";
import { AppServerCodebaseSymbolsService } from "../../browser/appServerCodebaseSymbolsService.js";

const readyStatus = Object.freeze({
	state: "ready" as const,
	rootId: "root-1",
	generation: 3,
	sourceGeneration: 7,
	indexedSourceCount: 2,
	indexedSymbolCount: 4,
	symbolLimitHit: false,
});

test("codebase-symbols service validates limits and removes transport nulls", async () => {
	let request: { readonly query: string; readonly maxResults: number } | undefined;
	const api: ICodebaseSymbolsApi = {
		status: async () => readyStatus,
		search: async params => {
			request = params;
			return {
				status: readyStatus,
				hits: [{
					name: "SessionStore",
					kind: "struct",
					containerName: null,
					path: "src/session.rs",
					language: "rust",
					sourceRevision: "sha256:current",
					declarationRange: { start: { lineIndex: 1, columnIndex: 0 }, end: { lineIndex: 3, columnIndex: 1 } },
					selectionRange: { start: { lineIndex: 1, columnIndex: 7 }, end: { lineIndex: 1, columnIndex: 19 } },
					score: 42,
					matchedIndices: [0, 7],
				}],
				discardedStaleHitCount: 1,
			};
		},
		synchronize: async () => ({ generation: 0, dirtyDocumentCount: 0 }),
		close: async () => ({ generation: 0, dirtyDocumentCount: 0 }),
	};
	const service = new AppServerCodebaseSymbolsService(api);

	const result = await service.search("ss", 25);

	assert.deepEqual(request, { query: "ss", maxResults: 25 });
	assert.equal(result.status.generation, 3);
	assert.equal(result.discardedStaleMatchCount, 1);
	assert.deepEqual(result.matches[0], {
		name: "SessionStore",
		kind: "struct",
		path: "src/session.rs",
		language: "rust",
		sourceRevision: "sha256:current",
		declarationRange: { start: { lineIndex: 1, columnIndex: 0 }, end: { lineIndex: 3, columnIndex: 1 } },
		selectionRange: { start: { lineIndex: 1, columnIndex: 7 }, end: { lineIndex: 1, columnIndex: 19 } },
		score: 42,
		matchedIndices: [0, 7],
	});
	await assert.rejects(service.search("x", 0), RangeError);
	await assert.rejects(service.search("x".repeat(8_193), 1), RangeError);
});
