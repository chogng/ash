import { VSBuffer } from "../../../../base/common/buffer.js";
import { raceCancellationError } from "../../../../base/common/async.js";
import type { CodebaseSymbolsSearchHitDto, CodebaseSymbolsStatusResult as CodebaseSymbolsStatusDto } from "../../../../platform/app-server/common/generated/index.js";
import type { ICodebaseSymbolsApi } from "../../../../platform/codebaseSymbols/common/codebaseSymbolsApi.js";
import type { ICodebaseSymbolsService, CodebaseSymbolsMatch, CodebaseSymbolsPosition, CodebaseSymbolsRange, CodebaseSymbolsSearchResult, CodebaseSymbolsStatus } from "../../../../platform/codebaseSymbols/common/codebaseSymbolsService.js";

const MAX_QUERY_BYTES = 8192;
const MAX_RESULTS = 100;

/** App Server transport adapter for the frontend codebase-symbols contract. */
export class AppServerCodebaseSymbolsService implements ICodebaseSymbolsService {
	constructor(private readonly api: ICodebaseSymbolsApi) {}

	async status(signal: AbortSignal = new AbortController().signal): Promise<CodebaseSymbolsStatus> {
		return status(await raceCancellationError(this.api.status(), signal, "Symbol-index status was cancelled"));
	}

	async search(query: string, maxResults: number, signal: AbortSignal = new AbortController().signal): Promise<CodebaseSymbolsSearchResult> {
		if (typeof query !== "string" || VSBuffer.fromString(query).byteLength > MAX_QUERY_BYTES) throw new RangeError("Symbol-index query exceeds its byte limit");
		if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) throw new RangeError("Symbol-index result limit is invalid");
		const response = await raceCancellationError(this.api.search({ query, maxResults }), signal, "Symbol-index search was cancelled");
		return Object.freeze({
			status: status(response.status),
			matches: Object.freeze(response.hits.map(match)),
			discardedStaleMatchCount: response.discardedStaleHitCount,
		});
	}
}

function status(value: CodebaseSymbolsStatusDto): CodebaseSymbolsStatus {
	return Object.freeze({
		state: value.state,
		rootId: value.rootId,
		generation: value.generation,
		sourceGeneration: value.sourceGeneration,
		indexedSourceCount: value.indexedSourceCount,
		indexedSymbolCount: value.indexedSymbolCount,
		symbolLimitHit: value.symbolLimitHit,
	});
}

function match(value: CodebaseSymbolsSearchHitDto): CodebaseSymbolsMatch {
	return Object.freeze({
		name: value.name,
		kind: value.kind,
		...(value.containerName === null ? {} : { containerName: value.containerName }),
		path: value.path,
		language: value.language,
		sourceRevision: value.sourceRevision,
		declarationRange: range(value.declarationRange),
		selectionRange: range(value.selectionRange),
		score: value.score,
		matchedIndices: Object.freeze([...value.matchedIndices]),
	});
}

function range(value: CodebaseSymbolsSearchHitDto["selectionRange"]): CodebaseSymbolsRange {
	return Object.freeze({ start: position(value.start), end: position(value.end) });
}

function position(value: CodebaseSymbolsSearchHitDto["selectionRange"]["start"]): CodebaseSymbolsPosition {
	return Object.freeze({ lineIndex: value.lineIndex, columnIndex: value.columnIndex });
}
