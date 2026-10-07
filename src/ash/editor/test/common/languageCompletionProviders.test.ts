import { strict as assert } from "node:assert";
import { test } from "mocha";
import { LanguageCompletionProviderRegistry } from '../../common/languageFeatureRegistry.js';
import { LanguageCompletionTriggerKind, createLanguageCompletionIncompleteRefreshContext, createLanguageCompletionInvokeContext, createLanguageCompletionTriggerCharacterContext, type LanguageCompletionContext, type LanguageCompletionProvider, type LanguageCompletionProviderCatalog } from '../../common/languages.js';

test("Completion provider registry preserves registration order and selectors", () => {
	using registry = new LanguageCompletionProviderRegistry();
	const catalogs: LanguageCompletionProviderCatalog[] = [];
	using catalogListener = registry.onDidChangeProviderCatalog(catalog => catalogs.push(catalog));
	const languages = ["typescript"];
	const triggers = ["."];
	const first = provider("first", languages, triggers);
	using firstRegistration = registry.register(first);
	using universalRegistration = registry.register(provider("universal", ["*"], [":"]));
	languages.push("javascript");
	triggers.push(":");

	assert.deepEqual(
		registry.getProviders("typescript", createLanguageCompletionInvokeContext()).map(entry => entry.id),
		["first", "universal"],
	);
	assert.deepEqual(
		registry.getProviders("javascript", createLanguageCompletionInvokeContext()).map(entry => entry.id),
		["universal"],
	);
	assert.deepEqual(
		registry.getProviders("typescript", createLanguageCompletionTriggerCharacterContext(".")).map(entry => entry.id),
		["first"],
	);
	assert.deepEqual(
		registry.getProviders("typescript", createLanguageCompletionTriggerCharacterContext(":")).map(entry => entry.id),
		["universal"],
	);
	assert.deepEqual(
		registry.getProviders("typescript", createLanguageCompletionIncompleteRefreshContext()).map(entry => entry.id),
		["first", "universal"],
	);
	assert.deepEqual(catalogs.map(catalog => catalog.revision), [1, 2]);
	assert.deepEqual(registry.providerCatalog.providers.map(entry => entry.id), ["first", "universal"]);
	assert.equal(Object.isFrozen(registry.providerCatalog.providers[0]), true);
});

test("Provider registration captures methods and unregisters independently", async () => {
	using registry = new LanguageCompletionProviderRegistry();
	const source = {
		id: "bound",
		languageIds: ["typescript"],
		calls: 0,
		provideCompletions(): undefined {
			this.calls += 1;
			return undefined;
		},
	};
	const registration = registry.register(source);
	const registered = registry.getProviders("typescript", createLanguageCompletionInvokeContext())[0]!;
	await registered.provideCompletions({} as never, new AbortController().signal);
	assert.equal(source.calls, 1);

	registration.dispose();
	assert.deepEqual(registry.getProviders("typescript", createLanguageCompletionInvokeContext()), []);
});

test("Provider registry validates identities, selectors, triggers, and lifecycle", () => {
	using registry = new LanguageCompletionProviderRegistry();
	using registration = registry.register(provider("one", ["typescript"], ["."]));
	assert.throws(
		() => registry.register(provider("one", ["javascript"], [])),
		/already registered/,
	);
	assert.throws(
		() => registry.register(provider("bad id", ["typescript"], [])),
		/provider ID/,
	);
	assert.throws(
		() => registry.register(provider("empty", [], [])),
		/declare language IDs/,
	);
	assert.throws(
		() => registry.register(provider("duplicate", ["typescript", "typescript"], [])),
		/language IDs must be unique/,
	);
	assert.throws(
		() => registry.register(provider("trigger", ["typescript"], [".", "."])),
		/trigger characters must be unique/,
	);
	assert.throws(
		() => createLanguageCompletionTriggerCharacterContext("ab"),
		/one Unicode code point/,
	);
	assert.throws(
		() => registry.getProviders("typescript", {
			kind: "unknown" as LanguageCompletionTriggerKind,
		} as LanguageCompletionContext),
		/Unknown language completion trigger kind/,
	);

	registry.dispose();
	assert.throws(
		() => registry.getProviders("typescript", createLanguageCompletionInvokeContext()),
		/already disposed/,
	);
});

test("a provider group replaces itself without colliding with stable IDs", () => {
	using registry = new LanguageCompletionProviderRegistry();
	using group = registry.registerGroup([provider("demo", ["typescript"], [])]);
	using external = registry.register(provider("external", ["typescript"], []));

	assert.throws(() => group.replace([provider("external", ["typescript"], [])]), /already registered/);
	assert.deepEqual(registry.getProviders("typescript", createLanguageCompletionInvokeContext()).map(candidate => candidate.id), ["demo", "external"]);

	group.replace([provider("demo", ["javascript"], [])]);
	assert.deepEqual(registry.getProviders("typescript", createLanguageCompletionInvokeContext()).map(candidate => candidate.id), ["external"]);
});

function provider(
	id: string,
	languageIds: readonly string[],
	triggerCharacters: readonly string[],
): LanguageCompletionProvider {
	return {
		id,
		languageIds,
		triggerCharacters,
		provideCompletions: () => undefined,
	};
}
