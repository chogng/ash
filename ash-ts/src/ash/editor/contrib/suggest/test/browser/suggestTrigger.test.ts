import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { type TextMeasurer } from "../../../../common/viewModel/textMeasurer.js";
import { CursorsController } from "../../../../common/cursor/cursor.js";
import { LanguageCompletionSessionController } from "../../common/languageCompletionSessionController.js";
import { LanguageCompletionService } from "../../../../common/languages/completion/languageCompletionService.js";
import { LanguageCompletionProviderRegistry, LanguageCompletionTriggerKind, type LanguageCompletionProvider, type LanguageCompletionProviderRequest, type LanguageCompletionProviderResult } from "../../../../common/languages/completion/languageCompletionProviders.js";
import { LanguageCompletionItemKind } from "../../../../common/languages/completion/languageCompletions.js";
import { Selection } from "../../../../common/core/selection.js";
import { Position } from "../../../../common/core/position.js";
import { Range } from "../../../../common/core/range.js";
import { TextModel } from "../../../../common/model/textModel.js";
import { SuggestController } from "../../browser/suggestController.js";
import { createTestCursorsController } from '../../../../test/common/testCursorConfiguration.js';

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	InputEvent: browserEnvironment.window.InputEvent,
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
})) {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
	});
}

const { TestView: View } = await import("../../../../test/browser/viewModel/testViewModel.js");
const { ViewController } = await import('../../../../browser/view/viewController.js');
test("Ctrl+Space requests providers through the completion service", async () => {
	const requests: LanguageCompletionProviderRequest[] = [];
	using fixture = createFixture({
		id: "typescript",
		languageIds: ["typescript"],
		provideCompletions: request => {
			requests.push(request);
			return completionResult(request, "const");
		},
	});
	const event = keyboardEvent(fixture.dom.window, " ", { ctrlKey: true });
	fixture.input.element.dispatchEvent(event);
	await waitFor(() => fixture.session.state !== undefined);

	assert.equal(event.defaultPrevented, true);
	assert.equal(requests.length, 1);
	assert.equal(requests[0]!.context.kind, LanguageCompletionTriggerKind.Invoke);
	assert.equal(requests[0]!.snapshot.getText(), "con");
	assert.equal(fixture.session.state!.selectedItem.providerId, "typescript");
	assert.equal(fixture.suggest.widget.visible, true);
});

test("A registered trigger character requests after the text transaction", async () => {
	const requests: LanguageCompletionProviderRequest[] = [];
	using fixture = createFixture({
		id: "member",
		languageIds: ["typescript"],
		triggerCharacters: ["."],
		provideCompletions: request => {
			requests.push(request);
			return completionResult(request, "method", true);
		},
	}, "obj");
	const event = beforeInputEvent(fixture.dom.window, ".");
	fixture.input.element.dispatchEvent(event);
	await waitFor(() => fixture.session.state !== undefined);

	assert.equal(event.defaultPrevented, true);
	assert.equal(fixture.model.getText(), "obj.");
	assert.equal(requests.length, 1);
	assert.equal(requests[0]!.context.kind, LanguageCompletionTriggerKind.TriggerCharacter);
	assert.equal(
		requests[0]!.context.kind === LanguageCompletionTriggerKind.TriggerCharacter
			? requests[0]!.context.triggerCharacter
			: undefined,
		".",
	);
	assert.equal(Position.compare(requests[0]!.position, new Position((0) + 1, (4) + 1)), 0);
	assert.equal(requests[0]!.snapshot.getText(), "obj.");
});

test("An auto-closed trigger character requests from the caret inside its pair", async () => {
	const requests: LanguageCompletionProviderRequest[] = [];
	using fixture = createFixture({
		id: "call",
		languageIds: ["typescript"],
		triggerCharacters: ["("],
		provideCompletions: request => {
			requests.push(request);
			return completionResult(request, "argument");
		},
	}, "call");

	fixture.input.element.dispatchEvent(beforeInputEvent(fixture.dom.window, "("));
	await waitFor(() => fixture.session.state !== undefined);

	assert.equal(fixture.model.getText(), "call()");
	assert.equal(requests.length, 1);
	assert.equal(Position.compare(requests[0]!.position, new Position((0) + 1, (5) + 1)), 0);
	assert.equal(requests[0]!.snapshot.getText(), "call()");
});

test("Typing after an incomplete result retriggers all providers at the new version", async () => {
	const requests: LanguageCompletionProviderRequest[] = [];
	using fixture = createFixture({
		id: "incomplete",
		languageIds: ["typescript"],
		provideCompletions: request => {
			requests.push(request);
			return completionResult(request, requests.length === 1 ? "const" : "continue", true);
		},
	});
	fixture.input.element.dispatchEvent(keyboardEvent(fixture.dom.window, " ", { ctrlKey: true }));
	await waitFor(() => fixture.session.state?.requestId === 1);

	fixture.input.element.dispatchEvent(beforeInputEvent(fixture.dom.window, "t"));
	await waitFor(() => fixture.session.state?.requestId === 2);

	assert.equal(fixture.model.getText(), "cont");
	assert.deepEqual(requests.map(request => request.context.kind), [
		LanguageCompletionTriggerKind.Invoke,
		LanguageCompletionTriggerKind.IncompleteRefresh,
	]);
	assert.equal(Position.compare(requests[1]!.position, new Position((0) + 1, (4) + 1)), 0);
	assert.equal(requests[1]!.snapshot.getText(), "cont");
	assert.equal(fixture.session.state!.selectedItem.label, "continue");
});

test("Deleting after an incomplete result retriggers providers at the new version", async () => {
	const requests: LanguageCompletionProviderRequest[] = [];
	using fixture = createFixture({
		id: "incomplete-delete",
		languageIds: ["typescript"],
		provideCompletions: request => {
			requests.push(request);
			return completionResult(request, request.snapshot.getText(), true);
		},
	});
	fixture.input.element.dispatchEvent(keyboardEvent(fixture.dom.window, " ", { ctrlKey: true }));
	await waitFor(() => fixture.session.state?.requestId === 1);

	fixture.input.element.dispatchEvent(beforeInputEvent(fixture.dom.window, null, "deleteContentBackward"));
	await waitFor(() => fixture.session.state?.requestId === 2);

	assert.equal(fixture.model.getText(), "co");
	assert.equal(requests[1]!.context.kind, LanguageCompletionTriggerKind.IncompleteRefresh);
	assert.equal(requests[1]!.snapshot.getText(), "co");
});

test("Completion request wiring rejects a same-model session from another service", () => {
	using registry = new LanguageCompletionProviderRegistry();
	using registration = registry.register({
		id: "one",
		languageIds: ["typescript"],
		provideCompletions: () => undefined,
	});
	using model = new TextModel("con");
	using firstService = new LanguageCompletionService(model, registry);
	using secondService = new LanguageCompletionService(model, registry);
	using selections = controllerAt(model, new Position((0) + 1, (3) + 1));
	using session = new LanguageCompletionSessionController(firstService.results, selections);
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	using viewport = new View({
		container: requiredElement<HTMLElement>(dom.window.document, "main"),
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
		selectionController: selections,
	});

	const input = viewport.controller;
	assert.throws(() => new SuggestController(input, selections, secondService, session, "typescript"), /must share one text model and completion result store/);
	dom.window.close();
});

interface TriggerFixture extends Disposable {
	readonly dom: JSDOM;
	readonly model: TextModel;
	readonly service: LanguageCompletionService;
	readonly session: LanguageCompletionSessionController;
	readonly input: InstanceType<typeof ViewController>;
	readonly suggest: SuggestController;
}

function createFixture(provider: LanguageCompletionProvider, text = "con"): TriggerFixture {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const registry = new LanguageCompletionProviderRegistry();
	const registration = registry.register(provider);
	const model = new TextModel(text);
	const service = new LanguageCompletionService(model, registry);
	const viewport = new View({
		container: requiredElement<HTMLElement>(dom.window.document, "main"),
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
	});
	const selections = viewport.testSelectionController;
	selections.setSelections([Selection.fromPositions(new Position((0) + 1, (text.length) + 1))]);
	const session = new LanguageCompletionSessionController(service.results, selections);
	viewport.layout({ width: 300, height: 40 });
	const input = viewport.controller;
	const suggest = new SuggestController(input, selections, service, session, "typescript");
	viewport.focus();
	return {
		dom,
		model,
		service,
		session,
		input,
		suggest,
		[Symbol.dispose](): void {
			suggest.dispose();
			viewport.dispose();
			session.dispose();
			selections.dispose();
			service.dispose();
			model.dispose();
			registration.dispose();
			registry.dispose();
			dom.window.close();
		},
	};
}

function completionResult(request: LanguageCompletionProviderRequest, label: string, isIncomplete = false): LanguageCompletionProviderResult {
	return {
		items: [{
			id: label,
			label,
			kind: LanguageCompletionItemKind.Keyword,
			range: Range.fromPositions(
				new Position(request.position.lineNumber, 1),
				request.position,
			),
			insertText: label,
		}],
		isIncomplete,
	};
}

function controllerAt(model: TextModel, position: Position): CursorsController {
	return createTestCursorsController(
		model,
		[Selection.fromPositions(position)],
	);
}

interface KeyOptions {
	readonly ctrlKey?: boolean;
}

function keyboardEvent(targetWindow: typeof browserEnvironment.window, key: string, options: KeyOptions = {}): KeyboardEvent {
	return new targetWindow.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key,
		ctrlKey: options.ctrlKey,
	}) as unknown as KeyboardEvent;
}

function beforeInputEvent(targetWindow: typeof browserEnvironment.window, data: string | null, inputType = "insertText"): InputEvent {
	return new targetWindow.InputEvent("beforeinput", {
		bubbles: true,
		cancelable: true,
		inputType,
		data,
	}) as unknown as InputEvent;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	}
	assert.fail("Timed out waiting for completion request");
}

function requiredElement<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
	const element = root.querySelector<T>(selector);
	assert.ok(element);
	return element;
}

class FixedTextMeasurer implements TextMeasurer {
	readonly horizontalPadding = 24;
	readonly contentLeftPadding = 12;

	refresh(): boolean {
		return false;
	}

	measureLineWidth(text: string): number {
		return text.length * 10;
	}
}
