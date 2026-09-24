import assert from "node:assert/strict";
import { test } from "mocha";

import { URI } from "../../../../../base/common/uri.js";
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { LanguageFeatureRegistry } from "../../../../../editor/common/languageFeatureRegistry.js";
import { type LanguageWorkspaceSymbol, type LanguageWorkspaceSymbolProvider } from '../../../../../editor/common/languages.js';
import { getWorkspaceSymbols } from '../../common/search.js';

const RANGE = Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (4) + 1));

test("workspace symbols publish fast providers before deterministic final fusion", async () => {
	const providers = new LanguageFeatureRegistry<LanguageWorkspaceSymbolProvider>();
	let releaseSlow!: (symbols: readonly LanguageWorkspaceSymbol[]) => void;
	providers.register('*', provider("slow", () => new Promise(resolve => { releaseSlow = resolve; })));
	providers.register('*', provider("fast", async () => [symbol("fast", "fast.ts")]));
	const updates: (readonly LanguageWorkspaceSymbol[])[] = [];

	const final = getWorkspaceSymbols(providers.allNoModel(), "f", new AbortController().signal, symbols => updates.push(symbols));
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(updates.at(-1)?.map(symbol => symbol.name), ["fast"]);

	releaseSlow([symbol("slow", "slow.ts")]);
	assert.deepEqual((await final).map(symbol => symbol.name), ["slow", "fast"]);
});

test("workspace symbol fusion deduplicates locations and survives provider failure", async () => {
	const providers = new LanguageFeatureRegistry<LanguageWorkspaceSymbolProvider>();
	providers.register('*', provider("preferred", async () => [symbol("same", "same.ts", "preferred")]));
	providers.register('*', provider("failed", async () => { throw new Error("unavailable"); }));
	providers.register('*', provider("duplicate", async () => [symbol("same", "same.ts", "duplicate"), symbol("other", "other.ts")]));

	const result = await getWorkspaceSymbols(providers.allNoModel(), "same");

	assert.deepEqual(result.map(symbol => symbol.name), ["same", "other"]);
	assert.equal(result[0]?.containerName, "preferred");
});

test('cancelled workspace symbol searches never publish late provider results', async () => {
	const controller = new AbortController();
	let finish!: (symbols: readonly LanguageWorkspaceSymbol[]) => void;
	const updates: (readonly LanguageWorkspaceSymbol[])[] = [];
	const pending = getWorkspaceSymbols([
		provider('slow', () => new Promise(resolve => { finish = resolve; })),
	], 'late', controller.signal, symbols => updates.push(symbols));

	controller.abort();
	finish([symbol('late', 'late.ts')]);

	assert.deepEqual({ result: await pending, updates }, { result: [], updates: [] });
});

function provider(providerId: string, provide: LanguageWorkspaceSymbolProvider["provideWorkspaceSymbols"]): LanguageWorkspaceSymbolProvider {
	void providerId;
	return { provideWorkspaceSymbols: provide };
}

function symbol(name: string, path: string, containerName?: string): LanguageWorkspaceSymbol {
	return { name, kind: "function", resource: URI.file(`/workspace/${path}`), range: RANGE, ...(containerName ? { containerName } : {}) };
}
