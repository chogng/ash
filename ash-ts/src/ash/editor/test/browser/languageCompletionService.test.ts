import { h } from '../../../base/browser/dom.js';
import { strict as assert } from "node:assert";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import { SuggestModel } from "../../contrib/suggest/browser/suggestModel.js";
import { LanguageCompletionService } from '../../contrib/suggest/browser/suggest.js';
import { LanguageCompletionProviderRegistry } from '../../common/languageFeatureRegistry.js';
import { LanguageCompletionTriggerKind, createLanguageCompletionIncompleteRefreshContext, createLanguageCompletionInvokeContext, createLanguageCompletionTriggerCharacterContext, type LanguageCompletionContext, type LanguageCompletionProvider, type LanguageCompletionProviderItem, type LanguageCompletionProviderRequest, type LanguageCompletionProviderResult, LanguageCompletionItemKind, LanguageCompletionInsertTextFormat } from '../../common/languages.js';
import { LanguageRequestCancellationReason, LanguageRequestStatus } from '../../common/model/languageRequestCoordinator.js';
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { TextModel } from "../../common/model/textModel.js";
const browserEnvironment = new JSDOM('<!doctype html><body></body>');
browserEnvironment.window.HTMLCanvasElement.prototype.getContext = () => null;
const globals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
})) {
	globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, name, { configurable: true, value });
}
const { createTestCodeEditor } = await import('./testCodeEditor.js');
suiteTeardown(() => {
	browserEnvironment.window.close();
	for (const [name, descriptor] of globals) {
		if (descriptor) {
			Object.defineProperty(globalThis, name, descriptor);
		} else {
			Reflect.deleteProperty(globalThis, name);
		}
	}
});

test("Completion service runs providers concurrently and merges deterministically", async () => {
	using registry = new LanguageCompletionProviderRegistry();
	const first = deferred<LanguageCompletionProviderResult>();
	const second = deferred<LanguageCompletionProviderResult>();
	const started: string[] = [];
	using firstRegistration = registry.register(provider("first", async () => {
		started.push("first");
		return first.promise;
	}));
	using secondRegistration = registry.register(provider("second", async () => {
		started.push("second");
		return second.promise;
	}));
	using model = new TextModel("con");
	using service = new LanguageCompletionService(model, registry);
	const request = service.request(
		"typescript",
		new Position((0) + 1, (3) + 1),
		createLanguageCompletionInvokeContext(),
	);
	assert.deepEqual(started, ["first", "second"]);
	second.resolve({
		items: [item("same", "console", true)],
		isIncomplete: true,
	});
	first.resolve({
		items: [item("same", "const", true)],
		isIncomplete: false,
	});

	assert.deepEqual(await request, {
		status: LanguageRequestStatus.Applied,
		requestId: 1,
		modelVersion: 1,
	});
	assert.deepEqual(service.results.result!.value.items.map(entry => ({
		providerId: entry.providerId,
		id: entry.id,
		label: entry.label,
		preselect: entry.preselect,
	})), [{
		providerId: "first",
		id: "same",
		label: "const",
		preselect: true,
	}, {
		providerId: "second",
		id: "same",
		label: "console",
		preselect: undefined,
	}]);
	assert.equal(service.results.result!.value.isIncomplete, true);
});

test("Trigger characters filter providers while invoke and refresh call all", async () => {
	using registry = new LanguageCompletionProviderRegistry();
	const calls: Array<{ id: string; context: LanguageCompletionContext }> = [];
	using dotRegistration = registry.register(provider("dot", request => {
		calls.push({ id: "dot", context: request.context });
		return result("dot");
	}, ["."]));
	using colonRegistration = registry.register(provider("colon", request => {
		calls.push({ id: "colon", context: request.context });
		return result("colon");
	}, [":"]));
	using plainRegistration = registry.register(provider("plain", request => {
		calls.push({ id: "plain", context: request.context });
		return result("plain");
	}));
	using model = new TextModel("con");
	using service = new LanguageCompletionService(model, registry);

	await service.request("typescript", new Position((0) + 1, (3) + 1), createLanguageCompletionTriggerCharacterContext("."));
	assert.deepEqual(calls.map(call => call.id), ["dot"]);
	assert.equal(calls[0]!.context.kind, LanguageCompletionTriggerKind.TriggerCharacter);

	calls.length = 0;
	await service.request("typescript", new Position((0) + 1, (3) + 1), createLanguageCompletionInvokeContext());
	assert.deepEqual(calls.map(call => call.id), ["dot", "colon", "plain"]);

	calls.length = 0;
	await service.request("typescript", new Position((0) + 1, (3) + 1), createLanguageCompletionIncompleteRefreshContext());
	assert.deepEqual(calls.map(call => call.id), ["dot", "colon", "plain"]);
	assert.equal(calls[0]!.context.kind, LanguageCompletionTriggerKind.IncompleteRefresh);
});

test("Provider failures and invalid snapshots are isolated from healthy results", async () => {
	using registry = new LanguageCompletionProviderRegistry();
	using rejectedRegistration = registry.register(provider("rejected", async () => {
		throw new Error("provider crash");
	}));
	using invalidRegistration = registry.register(provider("invalid", () => ({
		items: [item("invalid", "invalid", false, Range.fromPositions(
			new Position((0) + 1, (0) + 1),
			new Position((0) + 1, (4) + 1),
		))],
		isIncomplete: false,
	})));
	using healthyRegistration = registry.register(provider("healthy", () => result("healthy")));
	using model = new TextModel("con");
	const errors: Array<{ providerId: string; error: unknown }> = [];
	using service = new LanguageCompletionService(model, registry, {
		onProviderError: (providerId, error) => errors.push({ providerId, error }),
	});

	const outcome = await service.request(
		"typescript",
		new Position((0) + 1, (3) + 1),
		createLanguageCompletionInvokeContext(),
	);

	assert.equal(outcome.status, LanguageRequestStatus.Applied);
	assert.deepEqual(errors.map(entry => entry.providerId), ["rejected", "invalid"]);
	assert.deepEqual(
		service.results.result!.value.items.map(entry => entry.providerId),
		["healthy"],
	);
});

test("Model changes cancel provider work without reporting an external failure", async () => {
	using registry = new LanguageCompletionProviderRegistry();
	let observedSignal: AbortSignal | undefined;
	using registration = registry.register(provider("slow", (_request, signal) => {
		observedSignal = signal;
		return new Promise((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	}));
	using model = new TextModel("con");
	const errors: unknown[] = [];
	using service = new LanguageCompletionService(model, registry, {
		onProviderError: (_providerId, error) => errors.push(error),
	});
	const request = service.request(
		"typescript",
		new Position((0) + 1, (3) + 1),
		createLanguageCompletionInvokeContext(),
	);

	model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (3) + 1)),
		text: "s",
	}]);

	assert.equal(observedSignal!.aborted, true);
	assert.deepEqual(await request, {
		status: LanguageRequestStatus.Cancelled,
		requestId: 1,
		modelVersion: 1,
		reason: LanguageRequestCancellationReason.ModelChanged,
	});
	assert.equal(service.results.result, undefined);
	assert.deepEqual(errors, []);
});

test("Provider request flows through store, session, acceptance, and undo", async () => {
	using registry = new LanguageCompletionProviderRegistry();
	using registration = registry.register(provider("typescript", request => {
		assert.equal(request.snapshot.getText(), "con");
		assert.equal(Position.compare(request.position, new Position((0) + 1, (3) + 1)), 0);
		return {
			items: [item("console", "console", true)],
			isIncomplete: false,
		};
	}));
	using model = new TextModel("con");
	using service = new LanguageCompletionService(model, registry);
	using editor = createTestCodeEditor({ container: h(document, 'div'), model, contributions: [] });
	editor.setPosition(new Position(1, 4));
	using session = new SuggestModel(service.results, editor);

	await service.request("typescript", new Position((0) + 1, (3) + 1), createLanguageCompletionInvokeContext());
	assert.equal(session.state!.selectedItem.providerId, "typescript");
	assert.equal(session.acceptSelected(), true);
	assert.equal(model.getText(), "console");
	assert.equal(session.state, undefined);

	model.undo();
	assert.equal(model.getText(), "con");
	assert.equal(Position.compare(editor.getSelections()![0]!.getPosition(), new Position((0) + 1, (3) + 1)), 0);
});

test("Completion service disposal owns neither registry nor model", () => {
	using registry = new LanguageCompletionProviderRegistry();
	using registration = registry.register(provider("one", () => result("one")));
	using model = new TextModel("con");
	const service = new LanguageCompletionService(model, registry);
	service.dispose();

	assert.deepEqual(
		registry.getProviders("typescript", createLanguageCompletionInvokeContext()).map(entry => entry.id),
		["one"],
	);
	model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (3) + 1)),
		text: "!",
	}]);
	assert.equal(model.getText(), "con!");
});

test('Suggest rejects malformed snippet providers while keeping valid completions', async () => {
	using registry = new LanguageCompletionProviderRegistry();
	using invalid = registry.register(provider('invalid', () => ({
		items: [{ ...item('broken', 'broken'), insertText: '${1', insertTextFormat: LanguageCompletionInsertTextFormat.Snippet }],
		isIncomplete: false,
	})));
	using valid = registry.register(provider('valid', () => result('console')));
	using model = new TextModel('con');
	const failures: string[] = [];
	using service = new LanguageCompletionService(model, registry, { onProviderError: id => failures.push(id) });

	await service.request('typescript', new Position(1, 4), createLanguageCompletionInvokeContext());

	assert.deepEqual({
		failures,
		items: service.results.result?.value.items.map(item => item.label),
	}, { failures: ['invalid'], items: ['console'] });
});

function provider(
	id: string,
	provideCompletions: LanguageCompletionProvider["provideCompletions"],
	triggerCharacters: readonly string[] = [],
): LanguageCompletionProvider {
	return {
		id,
		languageIds: ["typescript"],
		triggerCharacters,
		provideCompletions,
	};
}

function result(label: string): LanguageCompletionProviderResult {
	return {
		items: [item(label, label)],
		isIncomplete: false,
	};
}

function item(
	id: string,
	label: string,
	preselect = false,
	range = Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (3) + 1)),
): LanguageCompletionProviderItem {
	return {
		id,
		label,
		kind: LanguageCompletionItemKind.Keyword,
		range,
		insertText: label,
		...(preselect ? { preselect } : {}),
	};
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(accept => {
		resolve = accept;
	});
	return { promise, resolve };
}
