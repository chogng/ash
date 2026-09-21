import { strict as assert } from "node:assert";
import { test } from "mocha";
import { LanguageCompletionProviderRegistry } from '../../common/languageFeatureRegistry.js';
import { createLanguageCompletionInvokeContext, type LanguageCompletionProvider, LanguageCompletionItemKind, type LanguageCompletionResolveRequest } from '../../common/languages.js';
import { LanguageCompletionService } from '../../contrib/suggest/browser/suggest.js';
import { LanguageRequestStatus } from '../../common/model/languageRequestCoordinator.js';
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { TextModel } from "../../common/model/textModel.js";

test("Completion service resolves deferred details against the exact provider item", async () => {
	using model = new TextModel("con");
	using registry = new LanguageCompletionProviderRegistry();
	const resolveData = { symbol: "console" };
	let resolvedData: unknown;
	using registration = registry.register(provider({
		resolveData,
		resolve: request => {
			resolvedData = request.item.resolveData;
			return {
				detail: "global variable",
				documentation: `Documentation for ${(request.item.resolveData as { symbol: string }).symbol}`,
			};
		},
	}));
	using service = new LanguageCompletionService(model, registry);

	const outcome = await service.request("typescript", new Position((0) + 1, (3) + 1), createLanguageCompletionInvokeContext());
	assert.equal(outcome.status, LanguageRequestStatus.Applied);
	const result = service.results.result!;
	const item = result.value.items[0]!;
	assert.equal(item.hasDeferredDetails, true);
	assert.equal("resolveData" in item, false);
	resolveData.symbol = "mutated";

	const details = await service.resolveCompletionItem(resolveRequest(result.requestId, result.modelVersion), new AbortController().signal);

	assert.deepEqual(details, {
		detail: "global variable",
		documentation: "Documentation for console",
	});
	assert.deepEqual(resolvedData, { symbol: "console" });
	assert.equal(item.label, "console");
	assert.equal(item.insertText, "console");
});

test("Resolve requests reject stale results and removed providers", async () => {
	using model = new TextModel("con");
	using registry = new LanguageCompletionProviderRegistry();
	const registration = registry.register(provider({
		resolveData: { symbol: "console" },
		resolve: () => ({ detail: "resolved" }),
	}));
	using service = new LanguageCompletionService(model, registry, {
		onProviderError: () => undefined,
	});
	await service.request("typescript", new Position((0) + 1, (3) + 1), createLanguageCompletionInvokeContext());
	const first = service.results.result!;

	await service.request("typescript", new Position((0) + 1, (3) + 1), createLanguageCompletionInvokeContext());
	await assert.rejects(
		service.resolveCompletionItem(resolveRequest(first.requestId, first.modelVersion), new AbortController().signal),
		/not the current deferred item/,
	);

	const current = service.results.result!;
	registration.dispose();
	await assert.rejects(
		service.resolveCompletionItem(resolveRequest(current.requestId, current.modelVersion), new AbortController().signal),
		/cannot be resolved/,
	);
});

test("Resolve output cannot mutate completion edit identity", async () => {
	using model = new TextModel("con");
	using registry = new LanguageCompletionProviderRegistry();
	const errors: Array<{ readonly providerId: string; readonly error: unknown }> = [];
	using registration = registry.register(provider({
		resolveData: { symbol: "console" },
		resolve: () => ({ insertText: "danger" }) as never,
	}));
	using service = new LanguageCompletionService(model, registry, {
		onProviderError: (providerId, error) => errors.push({ providerId, error }),
	});
	await service.request("typescript", new Position((0) + 1, (3) + 1), createLanguageCompletionInvokeContext());
	const result = service.results.result!;

	await assert.rejects(
		service.resolveCompletionItem(resolveRequest(result.requestId, result.modelVersion), new AbortController().signal),
		/unsupported field 'insertText'/,
	);

	assert.equal(result.value.items[0]!.insertText, "console");
	assert.equal(errors[0]!.providerId, "stanza.test");
	assert.match((errors[0]!.error as Error).message, /unsupported field/);
	assert.equal((await service.request("typescript", new Position((0) + 1, (3) + 1), createLanguageCompletionInvokeContext())).status, LanguageRequestStatus.Applied);
});

test("Provider output cannot forge deferred-details capability", async () => {
	using model = new TextModel("con");
	using registry = new LanguageCompletionProviderRegistry();
	using registration = registry.register({
		id: "stanza.plain",
		languageIds: ["typescript"],
		provideCompletions: () => ({
			items: [{
				id: "console",
				label: "console",
				kind: LanguageCompletionItemKind.Variable,
				range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (3) + 1)),
				insertText: "console",
				hasDeferredDetails: true,
			} as never],
			isIncomplete: false,
		}),
	});
	using service = new LanguageCompletionService(model, registry);

	await service.request("typescript", new Position((0) + 1, (3) + 1), createLanguageCompletionInvokeContext());

	assert.equal(service.results.result!.value.items[0]!.hasDeferredDetails, undefined);
});

function provider(options: {
	readonly resolveData: unknown;
	readonly resolve: NonNullable<LanguageCompletionProvider["resolveCompletionItem"]>;
}): LanguageCompletionProvider {
	return {
		id: "stanza.test",
		languageIds: ["typescript"],
		provideCompletions: () => ({
			items: [{
				id: "console",
				label: "console",
				kind: LanguageCompletionItemKind.Variable,
				range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (3) + 1)),
				insertText: "console",
				resolveData: options.resolveData,
			}],
			isIncomplete: false,
		}),
		resolveCompletionItem: options.resolve,
	};
}

function resolveRequest(completionRequestId: number, modelVersion: number): LanguageCompletionResolveRequest {
	return {
		completionRequestId,
		modelVersion,
		providerId: "stanza.test",
		itemId: "console",
	};
}
