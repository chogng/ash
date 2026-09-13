import assert from "node:assert/strict";
import { test } from "mocha";
import { TextMateGrammarService } from "../../common/textMateGrammarService.js";

test("grammar service materializes registered contributions into its catalog", async () => {
	using service = new TextMateGrammarService();
	using registration = service.registerGrammar({
		scopeName: "source.alpha",
		languageId: "alpha",
		loadGrammar: () => grammar("source.alpha"),
	});

	const catalog = await service.whenReady();
	assert.equal(catalog.revision, 1);
	assert.deepEqual(catalog.grammars.map(entry => entry.scopeName), ["source.alpha"]);
	assert.equal(service.currentCatalog, catalog);
});

test("grammar service publishes only the newest complete revision", async () => {
	using service = new TextMateGrammarService();
	let resolveGrammar: ((value: string) => void) | undefined;
	const delayedGrammar = new Promise<string>(resolve => {
		resolveGrammar = resolve;
	});
	const revisions: number[] = [];
	using listener = service.onDidChangeCatalog(catalog => revisions.push(catalog.revision));
	using first = service.registerGrammar({
		scopeName: "source.alpha",
		languageId: "alpha",
		loadGrammar: () => delayedGrammar,
	});
	using second = service.registerGrammar({
		scopeName: "source.beta",
		languageId: "beta",
		loadGrammar: () => grammar("source.beta"),
	});

	resolveGrammar?.(grammar("source.alpha"));
	const catalog = await service.whenReady();
	assert.equal(catalog.revision, 2);
	assert.deepEqual(catalog.grammars.map(entry => entry.languageId), ["alpha", "beta"]);
	assert.deepEqual(revisions, [2]);
});

test("grammar service preserves the last good catalog when a loader fails", async () => {
	using service = new TextMateGrammarService();
	using first = service.registerGrammar({
		scopeName: "source.alpha",
		languageId: "alpha",
		loadGrammar: () => grammar("source.alpha"),
	});
	const previous = await service.whenReady();
	const failures: { revision: number; error: unknown }[] = [];
	using listener = service.onDidFailCatalog(failure => failures.push(failure));
	using broken = service.registerGrammar({
		scopeName: "source.broken",
		languageId: "broken",
		loadGrammar: () => {
			throw new Error("broken grammar");
		},
	});

	await assert.rejects(service.whenReady(), /broken grammar/);
	assert.equal(service.currentCatalog, previous);
	assert.equal(failures.length, 1);
	assert.equal(failures[0]?.revision, 2);
});

test("disposing a registration republishes the remaining catalog", async () => {
	using service = new TextMateGrammarService();
	const first = service.registerGrammar({
		scopeName: "source.alpha",
		languageId: "alpha",
		loadGrammar: () => grammar("source.alpha"),
	});
	using second = service.registerGrammar({
		scopeName: "source.beta",
		languageId: "beta",
		loadGrammar: () => grammar("source.beta"),
	});
	await service.whenReady();

	first.dispose();
	const catalog = await service.whenReady();
	assert.equal(catalog.revision, 3);
	assert.deepEqual(catalog.grammars.map(entry => entry.languageId), ["beta"]);
});

test("a grouped registration replaces its own grammars in one revision", async () => {
	using service = new TextMateGrammarService();
	using registration = service.registerGrammars([{
		scopeName: "source.alpha",
		languageId: "alpha",
		loadGrammar: () => grammar("source.alpha"),
	}]);
	await service.whenReady();

	registration.replace([{
		scopeName: "source.alpha",
		languageId: "alpha",
		filePath: "updated.tmLanguage.json",
		loadGrammar: () => grammar("source.alpha"),
	}]);

	const catalog = await service.whenReady();
	assert.equal(catalog.revision, 2);
	assert.equal(catalog.grammars.length, 1);
	assert.equal(catalog.grammars[0]?.filePath, "updated.tmLanguage.json");
});

test("a grouped replacement rejects conflicts without changing its current definitions", async () => {
	using service = new TextMateGrammarService();
	using external = service.registerGrammar({ scopeName: "source.external", languageId: "external", loadGrammar: () => grammar("source.external") });
	using registration = service.registerGrammars([{ scopeName: "source.alpha", languageId: "alpha", loadGrammar: () => grammar("source.alpha") }]);
	const previous = await service.whenReady();

	assert.throws(() => registration.replace([{ scopeName: "source.external", languageId: "alpha", loadGrammar: () => grammar("source.external") }]), /already registered/);
	assert.equal(service.currentCatalog, previous);
	assert.deepEqual(service.currentCatalog.grammars.map(entry => entry.scopeName), ["source.external", "source.alpha"]);
});

test("prepared grammars validate before mutating the live registration", async () => {
	using service = new TextMateGrammarService();
	using registration = service.registerGrammars([{ scopeName: "source.old", languageId: "old", loadGrammar: () => grammar("source.old") }]);
	await service.whenReady();

	await assert.rejects(service.prepareGrammars(registration, [{ scopeName: "source.new", languageId: "new", loadGrammar: () => "not a grammar" }]));
	assert.equal(service.currentCatalog.grammars[0]?.scopeName, "source.old");

	const prepared = await service.prepareGrammars(registration, [{ scopeName: "source.new", languageId: "new", loadGrammar: () => grammar("source.new") }]);
	prepared.commit();
	assert.equal(service.currentCatalog.grammars[0]?.scopeName, "source.new");
});

test("prepared grammars reject a stale candidate when another registration changes", async () => {
	using service = new TextMateGrammarService();
	using registration = service.registerGrammars([{ scopeName: "source.old", languageId: "old", loadGrammar: () => grammar("source.old") }]);
	await service.whenReady();
	let resolveCandidate: ((value: string) => void) | undefined;
	const candidateGrammar = new Promise<string>(resolve => {
		resolveCandidate = resolve;
	});
	const preparing = service.prepareGrammars(registration, [{ scopeName: "source.new", languageId: "new", loadGrammar: () => candidateGrammar }]);
	using external = service.registerGrammar({ scopeName: "source.external", languageId: "external", loadGrammar: () => grammar("source.external") });

	resolveCandidate?.(grammar("source.new"));
	await assert.rejects(preparing, /registry changed during preparation/);
	const catalog = await service.whenReady();
	assert.deepEqual(catalog.grammars.map(entry => entry.scopeName), ["source.old", "source.external"]);
});

test("prepared grammars reject a registry change before commit", async () => {
	using service = new TextMateGrammarService();
	using registration = service.registerGrammars([{ scopeName: "source.old", languageId: "old", loadGrammar: () => grammar("source.old") }]);
	await service.whenReady();
	const prepared = await service.prepareGrammars(registration, [{ scopeName: "source.new", languageId: "new", loadGrammar: () => grammar("source.new") }]);
	using external = service.registerGrammar({ scopeName: "source.external", languageId: "external", loadGrammar: () => grammar("source.external") });

	assert.throws(() => prepared.commit(), /registry changed after preparation/);
	const catalog = await service.whenReady();
	assert.deepEqual(catalog.grammars.map(entry => entry.scopeName), ["source.old", "source.external"]);
});

function grammar(scopeName: string): string {
	return JSON.stringify({ scopeName, patterns: [] });
}
