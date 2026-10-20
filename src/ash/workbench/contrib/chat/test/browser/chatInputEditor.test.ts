import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import assert from "node:assert/strict";
import { setup, teardown, test, suiteTeardown } from "mocha";
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
const { ChatInputEditor } = await import("../../browser/widget/input/chatInputEditor.js");
const { ChatInputEditor: CoworkChatInputEditor } = await import('../../../../../sessions/contrib/cowork/browser/widget/input/chatInputEditor.js');
await import('../../browser/chat.shared.contribution.js');
const { ChatInputConfiguration } = await import('../../common/constants.js');
const { IConfigurationService } = await import('../../../../../platform/configuration/common/configuration.js');
const { createChatCommandCompletionProvider, createChatSkillCompletionProvider } = await import("../../browser/widget/input/editor/chatInputCompletions.js");
const { DesktopSlashCommands, SlashCommandCatalog } = await import("../../common/slashCommands.js");
const { SkillSelectorCatalog } = await import('../../common/skillSelectors.js');
const { Position } = await import("../../../../../editor/common/core/position.js");
const { EditorOption } = await import('../../../../../editor/common/config/editorOptions.js');
const { Range } = await import("../../../../../editor/common/core/range.js");
const { LanguageCompletionTriggerKind } = await import("../../../../../editor/common/languages.js");
const { TextModel } = await import("../../../../../editor/common/model/textModel.js");
const { ICodeEditorService } = await import("../../../../../editor/browser/services/codeEditorService.js");
const { ICommandService } = await import('../../../../../platform/commands/common/commands.js');
const { Selection } = await import('../../../../../editor/common/core/selection.js');
const { ChatDynamicVariableModel } = await import('../../browser/attachments/chatDynamicVariables.js');
const { SelectAllCommand } = await import("../../../../../editor/browser/editorExtensions.js");

suiteTeardown(() => browserEnvironment.window.close());

test('Inline code references track edits, atomic deletion, undo and redo in the real Chat editor', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using editorServices = new DisposableStore();
	const services = createCodeEditorServices(editorServices);
	using editor = services.createInstance(ChatInputEditor, { container: requiredElement<HTMLElement>(dom.window.document, 'main'), placeholder: 'Ask Ash', ariaLabel: 'Chat message', slashCommands: new SlashCommandCatalog([], []), skills: new SkillSelectorCatalog() });
	using references = new ChatDynamicVariableModel(editor);
	editor.value = 'Explain  please';
	editor.setSelection({ anchor: 8, active: 8 });
	references.addReference({ id: 'selection', kind: 'codeSelection', name: 'file.ts (6-9)', resolve: async () => ({ name: 'file.ts (6-9)', content: 'Unsaved code' }) });
	assert.equal(editor.value, 'Explain file.ts (6-9) please');
	assert.deepEqual(references.variables[0]?.reference, { start: 8, end: 21 });
	assert.equal(editor.getModel().getAllDecorations().filter(decoration => decoration.options.inlineClassName === 'ash-chat-code-reference').length, 1);
	editor.setSelection({ anchor: 0, active: 0 });
	editor.insertText('First: ');
	assert.deepEqual(references.variables[0]?.reference, { start: 15, end: 28 });
	editor.setSelection({ anchor: 28, active: 28 });
	editor.element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
	assert.equal(editor.value, 'First: Explain  please');
	assert.equal(references.variables.length, 0);
	await editor.getModel().undo();
	assert.equal(editor.value, 'First: Explain file.ts (6-9) please');
	assert.deepEqual(references.variables[0]?.reference, { start: 15, end: 28 });
	assert.equal((await references.variables[0]!.resolve()).content, 'Unsaved code');
	await editor.getModel().redo();
	assert.deepEqual(references.variables, []);
	// Typing the old label after deletion must not silently resurrect its code snapshot.
	editor.setSelection({ anchor: 15, active: 15 });
	editor.insertText('file.ts (6-9)');
	assert.deepEqual(references.variables, []);
});

test('Chat registers its focused editor for global commands and removes it on disposal', async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using editorServices = new DisposableStore();
	const services = createCodeEditorServices(editorServices);
	const editors = services.get(ICodeEditorService);
	const lifecycle: string[] = [];
	using willCreate = editors.onWillCreateCodeEditor(() => lifecycle.push('will'));
	using added = editors.onCodeEditorAdd(() => lifecycle.push('add'));
	using removed = editors.onCodeEditorRemove(() => lifecycle.push('remove'));
	using editor = services.createInstance(ChatInputEditor, { container: requiredElement<HTMLElement>(dom.window.document, "main"), placeholder: "Ask Ash", ariaLabel: "Chat message", slashCommands: new SlashCommandCatalog(DesktopSlashCommands, []), skills: new SkillSelectorCatalog() });
	editor.value = 'message';
	editor.focus();
	assert.equal(editors.listCodeEditors().length, 1);
	assert.deepEqual(lifecycle, ['will', 'add']);
	assert.equal(editor.element.querySelectorAll('.stanza-editor-completion').length, 1);
	const inputFont = editor.element.querySelector<HTMLElement>('.stanza-editor')!.style;
	assert.equal(inputFont.fontSize, '13px');
	assert.equal(inputFont.lineHeight, '20px');
	assert.doesNotMatch(inputFont.fontFamily.split(', monospace')[0]!, /^Menlo/u);
	assert.strictEqual(editors.getFocusedCodeEditor(), editors.listCodeEditors()[0]);
	await services.invokeFunction(accessor => SelectAllCommand.runCommand(accessor, undefined));
	assert.deepEqual(editors.getFocusedCodeEditor()?.getSelection(), new Selection(1, 1, 1, 8));
	editor.dispose();
	assert.equal(editors.listCodeEditors().length, 0);
	assert.deepEqual(lifecycle, ['will', 'add', 'remove']);
});

test('Chat typography updates preserve the draft and selection, resize the input, and reset independently of file fonts', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using editorServices = new DisposableStore();
	const services = createCodeEditorServices(editorServices);
	const configuration = services.get(IConfigurationService);
	using editor = services.createInstance(ChatInputEditor, { container: requiredElement<HTMLElement>(dom.window.document, 'main'), placeholder: 'Ask Ash', ariaLabel: 'Chat message', slashCommands: new SlashCommandCatalog(DesktopSlashCommands, []), skills: new SkillSelectorCatalog() });
	Object.defineProperty(editor.element, 'clientWidth', { value: 480 });
	editor.layout();
	editor.value = Array.from({ length: 6 }, (_, index) => `Line ${index + 1}`).join('\n');
	const codeEditor = services.get(ICodeEditorService).listCodeEditors()[0]!;
	codeEditor.setSelection(new Selection(2, 2, 3, 3));
	const selection = codeEditor.getSelection();
	const draft = editor.value;
	const font = editor.element.querySelector<HTMLElement>('.stanza-editor')!.style;
	const family = font.fontFamily;
	await waitFor(() => editor.element.style.height === '120px');
	await configuration.updateValue(ChatInputConfiguration.fontFamily, 'Arial');
	await configuration.updateValue(ChatInputConfiguration.fontSize, 18);
	await configuration.updateValue(ChatInputConfiguration.lineHeight, 30);
	await waitFor(() => editor.element.style.height === '180px');
	assert.match(font.fontFamily, /^Arial,/u);
	assert.equal(font.fontSize, '18px');
	assert.equal(font.lineHeight, '30px');
	assert.equal(editor.value, draft);
	assert.deepEqual(codeEditor.getSelection(), selection);
	await assert.rejects(configuration.updateValue(ChatInputConfiguration.fontFamily, 'Arial\nMenlo'));
	await assert.rejects(configuration.updateValue(ChatInputConfiguration.fontSize, 7));
	await assert.rejects(configuration.updateValue(ChatInputConfiguration.lineHeight, 7));
	await configuration.updateValue(ChatInputConfiguration.lineHeight, 0);
	assert.equal(font.lineHeight, `${codeEditor.getOption(EditorOption.fontInfo).lineHeight}px`);
	for (const key of Object.values(ChatInputConfiguration)) await configuration.updateValue(key, undefined);
	await waitFor(() => editor.element.style.height === '120px');
	assert.equal(font.fontFamily, family);
	assert.equal(font.fontSize, '13px');
	assert.equal(font.lineHeight, '20px');
	editor.dispose();
	await configuration.updateValue(ChatInputConfiguration.fontSize, 16);
	assert.equal(services.get(ICodeEditorService).listCodeEditors().length, 0);
});

test("Chat completion providers use one-based editor positions and ranges", async () => {
	const slashCommands = new SlashCommandCatalog(DesktopSlashCommands, []);
	using slashModel = new TextModel("/ne");
	const slashPosition = new Position(1, 4);
	const slashResult = await createChatCommandCompletionProvider(slashCommands).provideCompletions({
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
	const skillResult = await createChatSkillCompletionProvider(skills).provideCompletions({
		requestId: 2,
		languageId: "ash-chat-input",
		position: skillPosition,
		context: { kind: LanguageCompletionTriggerKind.Invoke },
		snapshot: skillModel.createVersionedSnapshot(),
	}, new AbortController().signal);
	assert.deepEqual(skillResult?.items[0]?.range, new Range(2, 5, 2, 9));
});

test('Chat slash provider finds description text without preselecting it', async () => {
	const catalog = new SlashCommandCatalog([], [
		{ name: 'doctor', description: 'Inspect workspace health', argumentMode: 'none' },
		{ name: 'config', description: 'Open workspace settings', argumentMode: 'none' },
	]);
	using model = new TextModel('/workspace');
	const result = await createChatCommandCompletionProvider(catalog).provideCompletions({
		requestId: 1,
		languageId: 'ash-chat-input',
		position: new Position(1, 11),
		context: { kind: LanguageCompletionTriggerKind.Invoke },
		snapshot: model.createVersionedSnapshot(),
	}, new AbortController().signal);
	assert.deepEqual(result?.items.map(item => [item.label, item.preselect, item.detailMatchIndices]), [
		['/config', false, [5, 6, 7, 8, 9, 10, 11, 12, 13]],
		['/doctor', false, [8, 9, 10, 11, 12, 13, 14, 15, 16]],
	]);
});

test("Chat input completes slash commands before submitting", async () => {
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
	await waitFor(() => completionLabels(editor.element).includes('/config'));
	for (const command of ['/new', '/history', '/config']) assert.ok(completionLabels(editor.element).includes(command));
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

test('Chat input shows a missing-character match without choosing it', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using editorServices = new DisposableStore();
	using editor = createCodeEditorServices(editorServices).createInstance(ChatInputEditor, {
		container: requiredElement<HTMLElement>(dom.window.document, 'main'),
		placeholder: 'Ask Ash',
		ariaLabel: 'Chat message',
		slashCommands: new SlashCommandCatalog(DesktopSlashCommands, []),
		skills: new SkillSelectorCatalog(),
	});
	let submissions = 0;
	using submitListener = editor.onDidSubmit(() => submissions += 1);
	const input = requiredElement<HTMLTextAreaElement>(editor.element, '.stanza-editor-input');
	editor.focus();
	input.dispatchEvent(beforeInputEvent(dom.window, '/'));
	await waitFor(() => completionLabels(editor.element).includes('/config'));
	for (const character of 'cofig') {
		input.dispatchEvent(beforeInputEvent(dom.window, character));
	}

	assert.equal(editor.value, '/cofig');
	await waitFor(() => completionLabels(editor.element).length > 0);
	assert.deepEqual(completionLabels(editor.element), ['/config']);
	assert.equal(editor.element.querySelector('.stanza-editor-completion-option.focused'), null);
	assert.deepEqual([...editor.element.querySelectorAll('.stanza-editor-completion-label strong')].map(element => element.textContent), ['c', 'o', 'f', 'i', 'g']);
	assert.equal(submissions, 0);

	const navigate = keyboardEvent(dom.window, 'ArrowDown');
	input.dispatchEvent(navigate);
	assert.equal(navigate.defaultPrevented, true);
	assert.equal(editor.element.querySelector('.stanza-editor-completion-option.focused .stanza-editor-completion-label')?.textContent, '/config');
	const accept = keyboardEvent(dom.window, 'Enter');
	input.dispatchEvent(accept);
	assert.equal(accept.defaultPrevented, true);
	assert.equal(editor.value, '/config ');
	assert.equal(submissions, 0);
	dom.window.close();
});

test('Chat input emphasizes a description-only command match', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using editorServices = new DisposableStore();
	using editor = createCodeEditorServices(editorServices).createInstance(ChatInputEditor, {
		container: requiredElement<HTMLElement>(dom.window.document, 'main'),
		placeholder: 'Ask Ash',
		ariaLabel: 'Chat message',
		slashCommands: new SlashCommandCatalog(DesktopSlashCommands, []),
		skills: new SkillSelectorCatalog(),
	});
	const input = requiredElement<HTMLTextAreaElement>(editor.element, '.stanza-editor-input');
	editor.focus();
	input.dispatchEvent(beforeInputEvent(dom.window, '/'));
	await waitFor(() => completionLabels(editor.element).includes('/config'));
	for (const character of 'settings') input.dispatchEvent(beforeInputEvent(dom.window, character));
	await waitFor(() => completionLabels(editor.element).includes('/config'));
	assert.deepEqual(completionLabels(editor.element), ['/config']);
	assert.equal(editor.element.querySelector('.stanza-editor-completion-option.focused'), null);
	assert.deepEqual([...editor.element.querySelectorAll('.stanza-editor-completion-detail strong')].map(element => element.textContent), [...'settings']);
	dom.window.close();
});

for (const kind of ['Code', 'Cowork'] as const) {
	test(`${kind} input discovers Skills through the shared \`$\` selector`, async () => {
		const dom = new JSDOM("<!doctype html><body><main></main></body>");
		using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
		dom.window.HTMLCanvasElement.prototype.getContext = () => null;
		const container = requiredElement<HTMLElement>(dom.window.document, "main");
		const catalog = new SlashCommandCatalog(DesktopSlashCommands, []);
		const skills = new SkillSelectorCatalog();
		using editorServices = new DisposableStore();
		const services = createCodeEditorServices(editorServices);
		const options = { container, placeholder: "Ask Ash", ariaLabel: "Chat message", slashCommands: catalog, skills };
		using editor = kind === 'Code' ? services.createInstance(ChatInputEditor, options) : services.createInstance(CoworkChatInputEditor, options);
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

	});
}

test('Chat command completion replaces the whole command and preserves arguments', async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement<HTMLElement>(dom.window.document, "main");
	using editorServices = new DisposableStore();
	const services = createCodeEditorServices(editorServices);
	using editor = services.createInstance(ChatInputEditor, { container, placeholder: "Ask Ash", ariaLabel: "Chat message", slashCommands: new SlashCommandCatalog(DesktopSlashCommands, []), skills: new SkillSelectorCatalog() });
	Object.defineProperty(editor.element, 'clientWidth', { value: 480 });
	editor.layout();
	editor.value = '/history argument';
	editor.focus();
	const input = requiredElement<HTMLElement>(editor.element, '.stanza-editor-input');
	input.dispatchEvent(keyboardEvent(dom.window, 'Home'));
	for (let index = 0; index < 3; index++) {
		input.dispatchEvent(keyboardEvent(dom.window, 'ArrowRight'));
	}
	await services.get(ICommandService).executeCommand('editor.action.triggerSuggest');
	await waitFor(() => completionLabels(editor.element)[0] === '/history');
	assert.equal(editor.element.querySelector('.stanza-editor-completion-option.focused .stanza-editor-completion-label')?.textContent, '/history');
	input.dispatchEvent(keyboardEvent(dom.window, 'Enter'));
	assert.equal(editor.value, '/history argument');
});

test("Chat input starts with two lines and grows and shrinks with content", async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement<HTMLElement>(dom.window.document, "main");
	using editorServices = new DisposableStore();
	using editor = createCodeEditorServices(editorServices).createInstance(ChatInputEditor, { container, placeholder: "Ask Ash", ariaLabel: "Chat message", slashCommands: new SlashCommandCatalog(DesktopSlashCommands, []), skills: new SkillSelectorCatalog() });
	Object.defineProperty(editor.element, 'clientWidth', { value: 480 });
	editor.layout();

	assert.equal(editor.element.style.height, "40px");
	editor.value = "First line\nSecond line";
	await waitFor(() => editor.element.style.height === "40px");
	editor.value += "\nThird line";
	await waitFor(() => editor.element.style.height === "60px");
	editor.value = Array.from({ length: 12 }, (_, index) => `Line ${index + 1}`).join("\n");
	await waitFor(() => editor.element.style.height === "240px");
	editor.value = Array.from({ length: 50 }, (_, index) => `Line ${index + 1}`).join("\n");
	await waitFor(() => editor.element.style.height === "314px");
	editor.value = "";
	await waitFor(() => editor.element.style.height === "40px");
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
	assert.fail("Timed out waiting for Chat input state");
}

function requiredElement<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
	const element = root.querySelector<T>(selector);
	assert.ok(element);
	return element;
}

// Embedded editors exercise the same admitted feature batch as the product host.
const { getEditorFeatures } = await import('../../../../../editor/browser/editorFeatures.js');
const { EditorExtensionsRegistry } = await import('../../../../../editor/browser/editorExtensions.js');
let editorFeatures: import('../../../../../base/common/lifecycle.js').IDisposable;
setup(() => { editorFeatures = EditorExtensionsRegistry.registerEditorFeatures(getEditorFeatures()); });
teardown(() => editorFeatures.dispose());
