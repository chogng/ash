import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";

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
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { createCodeEditorServices } = await import('../../../../../editor/test/browser/testCodeEditor.js');
const { ChatInputEditor } = await import("../../browser/input/stanzaChatInputEditor.js");
const { createStanzaChatCommandCompletionProvider } = await import("../../browser/input/stanzaChatCommandCompletion.js");
const { createStanzaChatSkillCompletionProvider } = await import("../../browser/input/stanzaChatSkillCompletion.js");
const { DesktopSlashCommands, SlashCommandCatalog } = await import("../../common/slashCommands.js");
const { SkillSelectorCatalog } = await import('../../common/skillSelectors.js');
const { Position } = await import("../../../../../editor/common/core/position.js");
const { Range } = await import("../../../../../editor/common/core/range.js");
const { LanguageCompletionTriggerKind } = await import("../../../../../editor/common/languages/completion/languageCompletionProviders.js");
const { TextModel } = await import("../../../../../editor/common/model/textModel.js");

suiteTeardown(() => browserEnvironment.window.close());

test("Chat completion providers use one-based editor positions and ranges", async () => {
	const slashCommands = new SlashCommandCatalog(DesktopSlashCommands, []);
	using slashModel = new TextModel("/ne");
	const slashPosition = new Position(1, 4);
	const slashResult = await createStanzaChatCommandCompletionProvider(slashCommands).provideCompletions({
		requestId: 1,
		languageId: "ash-chat-input",
		position: slashPosition,
		context: { kind: LanguageCompletionTriggerKind.Invoke },
		snapshot: slashModel.createVersionedSnapshot(),
	}, new AbortController().signal);
	assert.deepEqual(slashResult?.items[0]?.range, new Range(1, 1, 1, 4));

	const skills = new SkillSelectorCatalog();
	skills.setSkills([{
		name: "commit",
		description: "Draft a commit message",
		source: "user",
		skill: { id: { source: "user:skill-source:test", name: "commit" }, version: { type: "pinnedDigest", digest: "sha256:commit" } },
	}]);
	using skillModel = new TextModel("first line\nuse $com here");
	const skillPosition = new Position(2, 9);
	const skillResult = await createStanzaChatSkillCompletionProvider(skills).provideCompletions({
		requestId: 2,
		languageId: "ash-chat-input",
		position: skillPosition,
		context: { kind: LanguageCompletionTriggerKind.Invoke },
		snapshot: skillModel.createVersionedSnapshot(),
	}, new AbortController().signal);
	assert.deepEqual(skillResult?.items[0]?.range, new Range(2, 5, 2, 9));
});

test("Stanza Chat input completes slash commands before submitting", async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement<HTMLElement>(dom.window.document, "main");
	using editorServices = new DisposableStore();
	using editor = createCodeEditorServices(editorServices).createInstance(ChatInputEditor, { container, placeholder: "Ask Ash", ariaLabel: "Chat message", slashCommands: new SlashCommandCatalog(DesktopSlashCommands, []), skills: new SkillSelectorCatalog() });
	let submissions = 0;
	using submitListener = editor.onDidSubmit(() => submissions += 1);
	const input = requiredElement<HTMLTextAreaElement>(editor.element, ".stanza-editor-input");
	editor.focus();

	input.dispatchEvent(beforeInputEvent(dom.window, "/"));
	assert.equal(editor.value, "/");
	await waitFor(() => completionLabels(editor.element).length === 2);
	assert.deepEqual(completionLabels(editor.element), ["/new", "/history"]);
	assert.equal(editor.element.querySelector(".stanza-editor")?.classList.contains("stanza-editor-embedded"), true);
	assert.equal(editor.element.querySelector(".stanza-editor")?.classList.contains("word-wrapped"), true);
	assert.equal(editor.element.querySelector(".stanza-editor-line-number"), null);

	input.dispatchEvent(beforeInputEvent(dom.window, "n"));
	await waitFor(() => completionLabels(editor.element).length === 1);
	assert.deepEqual(completionLabels(editor.element), ["/new"]);

	const accept = keyboardEvent(dom.window, "Enter");
	input.dispatchEvent(accept);
	assert.equal(accept.defaultPrevented, true);
	assert.equal(editor.value, "/new ");
	assert.equal(submissions, 0);

	const submit = keyboardEvent(dom.window, "Enter");
	input.dispatchEvent(submit);
	assert.equal(submit.defaultPrevented, true);
	assert.equal(submissions, 1);
	dom.window.close();
});

test('Stanza Chat input discovers Skills only through the `$` selector', async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement<HTMLElement>(dom.window.document, "main");
	const catalog = new SlashCommandCatalog(DesktopSlashCommands, []);
	const skills = new SkillSelectorCatalog();
	using editorServices = new DisposableStore();
	using editor = createCodeEditorServices(editorServices).createInstance(ChatInputEditor, { container, placeholder: "Ask Ash", ariaLabel: "Chat message", slashCommands: catalog, skills });
	skills.setSkills([{
		name: "commit",
		description: "Draft a commit message",
		source: "user",
		skill: { id: { source: "user:skill-source:test", name: "commit" }, version: { type: "pinnedDigest", digest: "sha256:commit" } },
	}]);
	const input = requiredElement<HTMLTextAreaElement>(editor.element, ".stanza-editor-input");
	editor.focus();

	input.dispatchEvent(beforeInputEvent(dom.window, '$'));
	await waitFor(() => completionLabels(editor.element).length === 1);

	assert.deepEqual(completionLabels(editor.element), ['$commit']);
	const accept = keyboardEvent(dom.window, 'Enter');
	input.dispatchEvent(accept);
	assert.equal(editor.value, '$commit ');

	dom.window.close();
});

test("Stanza Chat input restores message behavior when the slash is deleted", async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement<HTMLElement>(dom.window.document, "main");
	using editorServices = new DisposableStore();
	using editor = createCodeEditorServices(editorServices).createInstance(ChatInputEditor, { container, placeholder: "Ask Ash", ariaLabel: "Chat message", slashCommands: new SlashCommandCatalog(DesktopSlashCommands, []), skills: new SkillSelectorCatalog() });
	const changes: string[] = [];
	using changeListener = editor.onDidChange(value => changes.push(value));
	const input = requiredElement<HTMLTextAreaElement>(editor.element, ".stanza-editor-input");
	editor.focus();

	input.dispatchEvent(beforeInputEvent(dom.window, "/"));
	assert.equal(editor.value, "/");
	await waitFor(() => completionLabels(editor.element).length > 0);
	input.dispatchEvent(beforeInputEvent(dom.window, "x"));
	await waitFor(() => editor.element.querySelector(".stanza-editor-completion.visible") === null);
	input.dispatchEvent(beforeInputEvent(dom.window, null, "deleteContentBackward"));
	await waitFor(() => completionLabels(editor.element).length > 0);
	input.dispatchEvent(beforeInputEvent(dom.window, null, "deleteContentBackward"));
	await waitFor(() => editor.element.querySelector(".stanza-editor-completion.visible") === null);

	assert.equal(editor.value, "");
	assert.deepEqual(changes, ["/", "/x", "/", ""]);
	const placeholder = requiredElement<HTMLElement>(editor.element, ".stanza-editor-placeholder-text");
	assert.equal(placeholder.hidden, false);
	assert.equal(placeholder.style.top, "0px");
	assert.equal(placeholder.style.left, "46px");
	dom.window.close();
});

test("Stanza Chat input starts at the InputPart default height and still grows with content", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement<HTMLElement>(dom.window.document, "main");
	using editorServices = new DisposableStore();
	using editor = createCodeEditorServices(editorServices).createInstance(ChatInputEditor, { container, placeholder: "Ask Ash", ariaLabel: "Chat message", slashCommands: new SlashCommandCatalog(DesktopSlashCommands, []), skills: new SkillSelectorCatalog() });

	assert.equal(editor.element.style.height, "106px");
	editor.value = Array.from({ length: 12 }, (_, index) => `Line ${index + 1}`).join("\n");
	assert.equal(editor.element.style.height, "240px");
	dom.window.close();
});

function completionLabels(root: ParentNode): string[] {
	return [...root.querySelectorAll<HTMLElement>(".stanza-editor-completion-label")].map(element => element.textContent ?? "");
}

function beforeInputEvent(targetWindow: typeof browserEnvironment.window, data: string | null, inputType = "insertText"): InputEvent {
	return new targetWindow.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data }) as unknown as InputEvent;
}

function keyboardEvent(targetWindow: typeof browserEnvironment.window, key: string): KeyboardEvent {
	return new targetWindow.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }) as unknown as KeyboardEvent;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	}
	assert.fail("Timed out waiting for Stanza Chat input state");
}

function requiredElement<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
	const element = root.querySelector<T>(selector);
	assert.ok(element);
	return element;
}
