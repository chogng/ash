import { strict as assert } from "node:assert";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import { ReplaceCommand } from '../../../../common/commands/replaceCommand.js';
import { LanguageCompletionDetailsStatus, LanguageCompletionSessionChangeReason, SuggestModel } from "../../browser/suggestModel.js";
import { LanguageResultAcceptance } from "../../../../common/languages/languageResultStore.js";
import { LanguageCompletionInsertTextFormat, LanguageCompletionItemKind, createLanguageCompletionStore, type LanguageCompletionItem, type LanguageCompletionItemDetails, type LanguageCompletionItemResolver, type LanguageCompletionResolveRequest } from "../../../../common/languages/completion/languageCompletions.js";
import { Selection } from "../../../../common/core/selection.js";
import { Position } from "../../../../common/core/position.js";
import { Range } from "../../../../common/core/range.js";
import { TextModel } from "../../../../common/model/textModel.js";
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
const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');
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

test("Completion session opens at the matching cursor and navigates cyclically", () => {
	using model = new TextModel("con");
	using editor = editorAt(model, new Position((0) + 1, (3) + 1));
	using store = createLanguageCompletionStore(model);
	using session = new SuggestModel(store, editor);
	const events: unknown[] = [];
	using listener = session.onDidChange(event => events.push({
		reason: event.reason,
		selected: event.state?.selectedItem.id,
	}));
	accept(store, model, 1, [
		completion("constant", "const"),
		completion("console", "console", true),
		completion("continue", "continue"),
	]);

	assert.equal(session.state!.selectedItem.id, "console");
	assert.equal(session.selectNext(), true);
	assert.equal(session.state!.selectedItem.id, "continue");
	assert.equal(session.selectNext(), true);
	assert.equal(session.state!.selectedItem.id, "constant");
	assert.equal(session.selectPrevious(), true);
	assert.equal(session.state!.selectedItem.id, "continue");
	assert.deepEqual(events.map(event => (event as { reason: string }).reason), [
		LanguageCompletionSessionChangeReason.Store,
		LanguageCompletionSessionChangeReason.Focus,
		LanguageCompletionSessionChangeReason.Focus,
		LanguageCompletionSessionChangeReason.Focus,
	]);
});

test("Same-version completion refresh retains focused item identity", () => {
	using model = new TextModel("con");
	using editor = editorAt(model, new Position((0) + 1, (3) + 1));
	using store = createLanguageCompletionStore(model);
	using session = new SuggestModel(store, editor);
	accept(store, model, 1, [
		completion("one", "one"),
		completion("two", "two"),
	]);
	session.selectIndex(1);

	accept(store, model, 2, [
		completion("two", "two updated"),
		completion("three", "three", true),
	]);

	assert.equal(session.state!.requestId, 2);
	assert.equal(session.state!.selectedIndex, 0);
	assert.equal(session.state!.selectedItem.id, "two");
	assert.equal(session.state!.selectedItem.label, "two updated");
});

test("Accepting a completion is one isolated selection-aware undo step", () => {
	using model = new TextModel("con tail");
	using editor = editorAt(model, new Position((0) + 1, (3) + 1));
	using store = createLanguageCompletionStore(model);
	using session = new SuggestModel(store, editor);
	const reasons: LanguageCompletionSessionChangeReason[] = [];
	using listener = session.onDidChange(event => reasons.push(event.reason));
	accept(store, model, 1, [
		completion("console", "console", false, Range.fromPositions(
			new Position((0) + 1, (0) + 1),
			new Position((0) + 1, (3) + 1),
		)),
	]);

	assert.equal(session.acceptSelected(), true);
	assert.equal(model.getText(), "console tail");
	assert.equal(Position.compare(editor.getSelections()![0]!.getPosition(), new Position((0) + 1, (7) + 1)), 0);
	assert.equal(session.state, undefined);
	assert.equal(reasons.at(-1), LanguageCompletionSessionChangeReason.Accepted);

	model.undo();
	assert.equal(model.getText(), "con tail");
	assert.equal(Position.compare(editor.getSelections()![0]!.getPosition(), new Position((0) + 1, (3) + 1)), 0);
});

test("A declared commit character accepts completion and text as one isolated undo step", () => {
	using model = new TextModel("con tail");
	using editor = editorAt(model, new Position((0) + 1, (3) + 1));
	using store = createLanguageCompletionStore(model);
	using session = new SuggestModel(store, editor);
	accept(store, model, 1, [{
		...completion("console", "console", false, Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (3) + 1))),
		commitCharacters: ["."],
	}]);

	assert.equal(session.acceptSelectedWithCommitCharacter("."), true);
	assert.equal(model.getText(), "console. tail");
	assert.equal(Position.compare(editor.getSelections()![0]!.getPosition(), new Position((0) + 1, (8) + 1)), 0);
	model.undo();
	assert.equal(model.getText(), "con tail");
	assert.equal(Position.compare(editor.getSelections()![0]!.getPosition(), new Position((0) + 1, (3) + 1)), 0);
});

test("Completion commands run after insertion against the updated model", async () => {
	using model = new TextModel("con");
	using editor = editorAt(model, new Position((0) + 1, (3) + 1));
	using store = createLanguageCompletionStore(model);
	const accepted: Array<{ readonly text: string; readonly item: LanguageCompletionItem }> = [];
	using session = new SuggestModel(store, editor, { onDidAccept: item => { accepted.push({ text: model.getText(), item }); } });
	accept(store, model, 1, [{
		...completion("console", "console"),
		command: { id: "server.afterInsert", title: "After insert", arguments: [{ value: 1 }] },
	}]);

	assert.equal(session.acceptSelected(), true);
	await turn();

	assert.equal(accepted[0]!.text, "console");
	assert.equal(accepted[0]!.item.command?.id, "server.afterInsert");
});

test("Completion acceptance applies additional edits and maps the caret through preceding changes", () => {
	using model = new TextModel("xcon");
	using editor = editorAt(model, new Position((0) + 1, (4) + 1));
	using store = createLanguageCompletionStore(model);
	using session = new SuggestModel(store, editor);
	assert.equal(store.accept({
		requestId: 1,
		textModel: model,
		modelVersion: model.version,
		value: {
			position: new Position((0) + 1, (4) + 1),
			items: [{
				...completion("console", "console", false, Range.fromPositions(new Position((0) + 1, (1) + 1), new Position((0) + 1, (4) + 1))),
				additionalTextEdits: [{ range: Range.fromPositions(new Position((0) + 1, (0) + 1)), text: "import " }],
			}],
			isIncomplete: false,
		},
	}), LanguageResultAcceptance.Applied);

	assert.equal(session.acceptSelected(), true);
	assert.equal(model.getText(), "import xconsole");
	assert.equal(Position.compare(editor.getSelections()![0]!.getPosition(), new Position((0) + 1, (15) + 1)), 0);
	model.undo();
	assert.equal(model.getText(), "xcon");
	assert.equal(Position.compare(editor.getSelections()![0]!.getPosition(), new Position((0) + 1, (4) + 1)), 0);
});

test("Completion snippets select grouped tabstops and leave them without changing text", () => {
	using model = new TextModel("fn");
	using editor = editorAt(model, new Position((0) + 1, (2) + 1));
	using store = createLanguageCompletionStore(model);
	using session = new SuggestModel(store, editor);
	assert.equal(store.accept({
		requestId: 1,
		textModel: model,
		modelVersion: model.version,
		value: {
			position: new Position((0) + 1, (2) + 1),
			items: [{
				...completion("function", "function", false, Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (2) + 1))),
				insertText: "function ${1:name}(${2:value}) { $0 }",
				insertTextFormat: LanguageCompletionInsertTextFormat.Snippet,
			}],
			isIncomplete: false,
		},
	}), LanguageResultAcceptance.Applied);

	assert.equal(session.acceptSelected(), true);
	assert.equal(model.getText(), "function name(value) {  }");
	assert.deepEqual(editor.getSelections()![0]!, Selection.fromPositions(new Position((0) + 1, (9) + 1), new Position((0) + 1, (13) + 1)));
	assert.equal(session.selectNextSnippetPlaceholder(), true);
	assert.deepEqual(editor.getSelections()![0]!, Selection.fromPositions(new Position((0) + 1, (14) + 1), new Position((0) + 1, (19) + 1)));
	assert.equal(session.selectNextSnippetPlaceholder(), true);
	assert.deepEqual(editor.getSelections()![0]!, Selection.fromPositions(new Position((0) + 1, (23) + 1)));
	assert.equal(session.selectPreviousSnippetPlaceholder(), true);
	assert.deepEqual(editor.getSelections()![0]!, Selection.fromPositions(new Position((0) + 1, (14) + 1), new Position((0) + 1, (19) + 1)));
	assert.equal(session.cancelSnippetPlaceholderNavigation(), true);
	assert.equal(session.selectNextSnippetPlaceholder(), false);
	assert.equal(model.getText(), "function name(value) {  }");
});

for (const transform of [false, true]) {
	test(`Completion snippet choices and mirrors undo atomically ${transform ? 'with' : 'without'} transforms`, () => {
		using model = new TextModel("x");
		using editor = editorAt(model, new Position((0) + 1, (1) + 1));
		using store = createLanguageCompletionStore(model);
		using session = new SuggestModel(store, editor);
		assert.equal(store.accept({
			requestId: 1,
			textModel: model,
			modelVersion: model.version,
			value: {
				position: new Position((0) + 1, (1) + 1),
				items: [{
					...completion("choice", "choice", false, Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (1) + 1))),
					insertText: transform ? "${1|a,long|}-$1 => ${1/(.*)/${1:/upcase}/}$0" : "${1|a,long|}-$1$0",
					insertTextFormat: LanguageCompletionInsertTextFormat.Snippet,
				}],
				isIncomplete: false,
			},
		}), LanguageResultAcceptance.Applied);

		assert.equal(session.acceptSelected(), true);
		const initial = transform ? 'a-a => A' : 'a-a';
		const expanded = transform ? 'long-long => LONG' : 'long-long';
		assert.equal(model.getText(), initial);
		editor.updateOptions({ readOnly: true });
		assert.equal(session.selectNextSnippetChoice(), false);
		assert.equal(model.getText(), initial);
		editor.updateOptions({ readOnly: false });
		const changes: string[] = [];
		using listener = model.onDidChangeContent(() => changes.push(model.getText()));
		assert.equal(session.selectNextSnippetChoice(), true);
		assert.deepEqual(changes, [expanded]);
		assert.deepEqual(editor.getSelections(), primaryFirst([
			Selection.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (4) + 1)),
			Selection.fromPositions(new Position((0) + 1, (5) + 1), new Position((0) + 1, (9) + 1)),
		], 0));
		model.undo();
		assert.equal(model.getText(), initial);
		assert.equal(session.selectNextSnippetChoice(), true);
		assert.equal(model.getText(), expanded);
		assert.equal(session.selectPreviousSnippetChoice(), true);
		assert.equal(model.getText(), initial);
		model.undo();
		assert.equal(model.getText(), expanded);
		model.undo();
		assert.equal(model.getText(), initial);
		assert.equal(session.selectNextSnippetChoice(), true);
		assert.equal(model.getText(), expanded);
		model.undo();
		assert.equal(model.getText(), initial);
		model.redo();
		assert.equal(model.getText(), expanded);
		assert.equal(session.selectPreviousSnippetChoice(), true);
		assert.equal(model.getText(), initial);
	});
}

test("Completion snippets refresh tabstop transforms when navigation leaves a source group", () => {
	using model = new TextModel("x");
	using editor = editorAt(model, new Position((0) + 1, (1) + 1));
	using store = createLanguageCompletionStore(model);
	using session = new SuggestModel(store, editor);
	assert.equal(store.accept({
		requestId: 1,
		textModel: model,
		modelVersion: model.version,
		value: {
			position: new Position((0) + 1, (1) + 1),
			items: [{
				...completion("transform", "transform", false, Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (1) + 1))),
				insertText: "${1:name} => ${1/(.*)/${1:/upcase}/}$0",
				insertTextFormat: LanguageCompletionInsertTextFormat.Snippet,
			}],
			isIncomplete: false,
		},
	}), LanguageResultAcceptance.Applied);

	assert.equal(session.acceptSelected(), true);
	assert.equal(model.getText(), "name => NAME");
	editor.executeCommand("test", new ReplaceCommand(
		Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (4) + 1)),
		"next",
	));
	assert.equal(model.getText(), "next => NAME");
	assert.equal(session.selectNextSnippetPlaceholder(), true);
	assert.equal(model.getText(), "next => NEXT");
});

test("Completion snippets resolve caller-provided editor variables on acceptance", () => {
	using model = new TextModel("f");
	using editor = editorAt(model, new Position((0) + 1, (1) + 1));
	using store = createLanguageCompletionStore(model);
	using session = new SuggestModel(store, editor, {
		snippetVariables: {
			resolveVariable(name): string | undefined {
				return name === "TM_FILENAME_BASE" ? "main" : undefined;
			},
		},
	});
	assert.equal(store.accept({
		requestId: 1,
		textModel: model,
		modelVersion: model.version,
		value: {
			position: new Position((0) + 1, (1) + 1),
			items: [{
				...completion("file", "file", false, Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (1) + 1))),
				insertText: "${1:$TM_FILENAME_BASE}.test",
				insertTextFormat: LanguageCompletionInsertTextFormat.Snippet,
			}],
			isIncomplete: false,
		},
	}), LanguageResultAcceptance.Applied);

	assert.equal(session.acceptSelected(), true);
	assert.equal(model.getText(), "main.test");
	assert.deepEqual(editor.getSelections()![0]!, Selection.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (4) + 1)));
});

test("Completion commit characters reject undeclared or multi-grapheme input without changing state", () => {
	using model = new TextModel("con");
	using editor = editorAt(model, new Position((0) + 1, (3) + 1));
	using store = createLanguageCompletionStore(model);
	using session = new SuggestModel(store, editor);
	accept(store, model, 1, [{ ...completion("console", "console"), commitCharacters: ["."] }]);

	assert.equal(session.acceptSelectedWithCommitCharacter("("), false);
	assert.equal(model.getText(), "con");
	assert.throws(() => session.acceptSelectedWithCommitCharacter("ab"), /one non-line-break grapheme/);
	assert.equal(model.getText(), "con");
});

test("Selection changes and explicit cancellation close only the local session", () => {
	using model = new TextModel("con");
	using editor = editorAt(model, new Position((0) + 1, (3) + 1));
	using store = createLanguageCompletionStore(model);
	using session = new SuggestModel(store, editor);
	accept(store, model, 1, [completion("const", "const")]);

	editor.setSelections([Selection.fromPositions(new Position((0) + 1, (2) + 1))]);
	assert.equal(session.state, undefined);
	assert.notEqual(store.result, undefined);

	editor.setSelections([Selection.fromPositions(new Position((0) + 1, (3) + 1))]);
	accept(store, model, 2, [completion("continue", "continue")]);
	assert.equal(session.cancel(), true);
	assert.equal(session.cancel(), false);
	assert.notEqual(store.result, undefined);
});

test("Completion session rejects cross-model wiring and owns no dependencies", () => {
	using model = new TextModel("con");
	using otherModel = new TextModel("other");
	using editor = editorAt(model, new Position((0) + 1, (3) + 1));
	using otherStore = createLanguageCompletionStore(otherModel);
	assert.throws(
		() => new SuggestModel(otherStore, editor),
		/must share one text model/,
	);

	using store = createLanguageCompletionStore(model);
	const session = new SuggestModel(store, editor);
	session.dispose();
	assert.throws(() => session.state, /already disposed/);
	accept(store, model, 1, [completion("const", "const")]);
	model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (3) + 1)),
		text: "!",
	}]);
	assert.equal(model.getText(), "con!");
});

test("Completion session resolves only the focused item and cancels superseded details", async () => {
	using model = new TextModel("con");
	using editor = editorAt(model, new Position((0) + 1, (3) + 1));
	using store = createLanguageCompletionStore(model);
	const resolver = new ControlledResolver();
	const errors: unknown[] = [];
	using session = new SuggestModel(store, editor, {
		resolver,
		onResolveError: error => errors.push(error),
	});
	accept(store, model, 1, [
		{ ...completion("one", "one"), hasDeferredDetails: true },
		{ ...completion("two", "two"), hasDeferredDetails: true },
	]);
	await turn();

	assert.equal(session.state!.detailsStatus, LanguageCompletionDetailsStatus.Loading);
	assert.deepEqual(resolver.requests.map(entry => entry.request.itemId), ["one"]);
	session.selectIndex(1);
	await turn();
	assert.equal(resolver.requests[0]!.signal.aborted, true);
	assert.deepEqual(resolver.requests.map(entry => entry.request.itemId), ["one", "two"]);

	resolver.complete("two", {
		detail: "resolved detail",
		documentation: "resolved documentation",
	});
	await turn();

	assert.equal(session.state!.detailsStatus, LanguageCompletionDetailsStatus.Complete);
	assert.deepEqual(session.state!.details, {
		detail: "resolved detail",
		documentation: "resolved documentation",
	});
	assert.deepEqual(errors, []);

	accept(store, model, 2, [
		{ ...completion("failed", "failed"), hasDeferredDetails: true },
	]);
	await turn();
	resolver.fail("failed", new Error("resolve failed"));
	await turn();
	assert.equal(session.state!.detailsStatus, LanguageCompletionDetailsStatus.Failed);
	assert.match((errors[0] as Error).message, /resolve failed/);
});

test('Read-only completion acceptance leaves the model and command untouched', async () => {
	using model = new TextModel('con');
	using editor = editorAt(model, new Position(1, 4));
	using store = createLanguageCompletionStore(model);
	const commands: string[] = [];
	using session = new SuggestModel(store, editor, { onDidAccept: item => { commands.push(item.id); } });
	accept(store, model, 1, [{ ...completion('console', 'console'), command: { id: 'afterInsert', title: 'After insert', arguments: [] } }]);
	editor.updateOptions({ readOnly: true });
	const version = model.getVersionId();
	assert.equal(session.acceptSelected(), false);
	await turn();
	assert.deepEqual({ text: model.getText(), version: model.getVersionId(), commands }, { text: 'con', version, commands: [] });
	editor.updateOptions({ readOnly: false });
	assert.equal(session.acceptSelected(), true);
	assert.equal(model.getText(), 'console');
});

test('Switching the editor model cancels completion resolution and releases the old session', async () => {
	using model = new TextModel('con');
	using otherModel = new TextModel('other');
	using editor = editorAt(model, new Position(1, 4));
	using store = createLanguageCompletionStore(model);
	let signal: AbortSignal | undefined;
	let complete: ((details: LanguageCompletionItemDetails) => void) | undefined;
	const resolver: LanguageCompletionItemResolver = {
		resolveCompletionItem(_request, requestSignal) {
			signal = requestSignal;
			return new Promise(resolve => { complete = resolve; });
		},
	};
	using session = new SuggestModel(store, editor, { resolver });
	accept(store, model, 1, [{ ...completion('console', 'console'), hasDeferredDetails: true }]);
	await turn();
	editor.setModel(otherModel);
	assert.equal(session.isDisposed, true);
	assert.equal(signal?.aborted, true);
	assert.ok(complete);
	complete({ detail: 'late result' });
	await turn();
	assert.deepEqual([model.getText(), otherModel.getText()], ['con', 'other']);
	assert.throws(() => session.acceptSelected(), /already disposed/);
});

function accept(
	store: ReturnType<typeof createLanguageCompletionStore>,
	model: TextModel,
	requestId: number,
	items: readonly LanguageCompletionItem[],
): void {
	assert.equal(store.accept({
		requestId,
		textModel: model,
		modelVersion: model.version,
		value: {
			position: new Position((0) + 1, (3) + 1),
			items,
			isIncomplete: false,
		},
	}), LanguageResultAcceptance.Applied);
}

function completion(id: string, label: string, preselect = false, range = Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (3) + 1))): LanguageCompletionItem {
	return {
		providerId: "test",
		id,
		label,
		kind: LanguageCompletionItemKind.Keyword,
		range,
		insertText: label,
		...(preselect ? { preselect } : {}),
	};
}

function editorAt(model: TextModel, position: Position): ReturnType<typeof createTestCodeEditor> {
	const editor = createTestCodeEditor({ container: document.createElement('div'), model, input: { resource: model.uri }, languageId: 'plaintext', contributions: [] });
	editor.setPosition(position);
	return editor;
}

function turn(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}

class ControlledResolver implements LanguageCompletionItemResolver {
	readonly requests: Array<{
		readonly request: LanguageCompletionResolveRequest;
		readonly signal: AbortSignal;
		readonly resolve: (details: LanguageCompletionItemDetails) => void;
		readonly reject: (error: unknown) => void;
	}> = [];

	resolveCompletionItem(request: LanguageCompletionResolveRequest, signal: AbortSignal): Promise<LanguageCompletionItemDetails> {
		return new Promise((resolve, reject) => {
			this.requests.push({ request, signal, resolve, reject });
			signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
		});
	}

	complete(itemId: string, details: LanguageCompletionItemDetails): void {
		this.pending(itemId).resolve(details);
	}

	fail(itemId: string, error: Error): void {
		this.pending(itemId).reject(error);
	}

	private pending(itemId: string): (typeof this.requests)[number] {
		const request = this.requests.find(entry => entry.request.itemId === itemId && !entry.signal.aborted);
		assert.ok(request);
		return request;
	}
}

function primaryFirst<T>(items: readonly T[], primaryIndex: number): readonly T[] {
	if (primaryIndex === 0) return Object.freeze([...items]);
	return Object.freeze([items[primaryIndex]!, ...items.slice(0, primaryIndex), ...items.slice(primaryIndex + 1)]);
}
