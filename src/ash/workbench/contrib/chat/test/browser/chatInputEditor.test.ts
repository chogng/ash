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
await import('../../browser/chat.shared.contribution.js');
const { ChatInputConfiguration } = await import('../../common/constants.js');
const { IConfigurationService } = await import('../../../../../platform/configuration/common/configuration.js');
const { createChatCommandCompletionProvider, createChatSkillCompletionProvider } = await import("../../browser/widget/input/editor/chatInputCompletions.js");
const { DesktopSlashCommands, SlashCommandCatalog } = await import("../../common/slashCommands.js");
const { SkillSelectorCatalog } = await import('../../common/skillSelectors.js');
const { PositionAffinity } = await import('../../../../../editor/common/model.js');
const { Position } = await import("../../../../../editor/common/core/position.js");
const { EditorOption } = await import('../../../../../editor/common/config/editorOptions.js');
const { Range } = await import("../../../../../editor/common/core/range.js");
const { LanguageCompletionTriggerKind } = await import("../../../../../editor/common/languages.js");
const { TextModel } = await import("../../../../../editor/common/model/textModel.js");
const { ICodeEditorService } = await import("../../../../../editor/browser/services/codeEditorService.js");
const { ICommandService } = await import('../../../../../platform/commands/common/commands.js');
const { Selection } = await import('../../../../../editor/common/core/selection.js');
const { ChatDynamicVariableModel, dynamicVariableDecorationType } = await import('../../browser/attachments/chatDynamicVariables.js');
const { SelectAllCommand } = await import("../../../../../editor/browser/editorExtensions.js");
const { URI } = await import('../../../../../base/common/uri.js');
const { IEditorService } = await import('../../../../services/editor/common/editorService.js');
const { emptyEditorServiceState } = await import('../../../../test/common/testEditorService.js');
const { IChatSessionNavigationService } = await import('../../../../services/chat/common/chatSessionNavigationService.js');
const { IResourceIconRenderer } = await import('../../../../browser/labels.js');
const { noFileIconTheme } = await import('../../../../../platform/theme/common/themeService.js');
const { Emitter, Event: AshEvent } = await import('../../../../../base/common/event.js');

suiteTeardown(() => browserEnvironment.window.close());

test('References constrain mouse, keyboard and API selections to whole model and visual boundaries', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using resources = new DisposableStore();
	const services = createChatInputServices(resources);
	using editor = services.createInstance(ChatInputEditor, { container: requiredElement<HTMLElement>(dom.window.document, 'main'), placeholder: 'Ask Ash', ariaLabel: 'Chat message', slashCommands: new SlashCommandCatalog([], []), skills: new SkillSelectorCatalog() });
	using references = new ChatDynamicVariableModel(editor);
	editor.value = 'Before  after';
	editor.setSelection({ anchor: 7, active: 7 });
	const context = references.addReference({ id: 'file', kind: 'file', name: 'settings.json (14-15)', resource: URI.file('/settings.json'), resolve: async () => ({ name: 'settings.json', content: 'Saved text' }) });
	const { start, end } = context.reference!;
	const model = editor.getModel();
	const native = editor.codeEditor;
	const move = (offset: number, source: string) => native.setPosition(model.getPositionAt(offset), source);
	move(start + 2, 'mouse');
	assert.deepEqual(editor.getSelection(), { anchor: start, active: start });
	move(end - 2, 'mouse');
	assert.deepEqual(editor.getSelection(), { anchor: end, active: end });
	const view = native._getViewModel()!;
	assert.ok(view.getPrimaryCursorState().viewState.selection.isEmpty());
	assert.equal(view.getPrimaryCursorState().viewState.position.column, view.coordinatesConverter.convertModelPositionToViewPosition(model.getPositionAt(end), PositionAffinity.Right).column);
	move(start, 'api');
	move(start + 1, 'keyboard');
	assert.deepEqual(editor.getSelection(), { anchor: end, active: end });
	move(end - 1, 'keyboard');
	assert.deepEqual(editor.getSelection(), { anchor: start, active: start });
	for (const [anchor, active, expected] of [
		[start, start + 1, { anchor: start, active: end }],
		[end, end - 1, { anchor: end, active: start }],
		[start + 2, end - 2, { anchor: start, active: end }],
	] as const) {
		native.setSelection(Selection.fromPositions(model.getPositionAt(anchor), model.getPositionAt(active)), 'mouse');
		assert.deepEqual(editor.getSelection(), expected);
	}
	editor.insertText('replacement');
	assert.equal(editor.value, 'Before replacement after');
	assert.deepEqual(references.variables, []);
});

test('Reference icons borrow the file theme, refresh with it and leave non-file sources empty', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using resources = new DisposableStore();
	const services = resources.add(createChatInputServices(resources).createChild());
	using changed = new Emitter<void>();
	let version = 'first';
	services.registerInstance(IResourceIconRenderer, {
		onDidChangeResourceIcons: changed.event,
		getFileIconTheme: () => ({ ...noFileIconTheme, hasFileIcons: true }),
		renderFileIcon: (resource, container) => { container.dataset.fileIcon = `${resource.path}:${version}`; },
	});
	using editor = services.createInstance(ChatInputEditor, { container: requiredElement<HTMLElement>(dom.window.document, 'main'), placeholder: 'Ask Ash', ariaLabel: 'Chat message', slashCommands: new SlashCommandCatalog([], []), skills: new SkillSelectorCatalog() });
	using references = new ChatDynamicVariableModel(editor);
	for (const [id, uri] of [['file', 'file:///workspace/settings.json'], ['output', 'output:/rust-analyzer'], ['debug', 'inmemory:/debug-console'], ['anonymous', 'inmemory:/console']] as const) {
		references.addReference({ id, kind: 'codeSelection', name: id, resource: URI.parse(uri), resolve: async () => ({ name: id, content: id }) });
	}
	const icons = () => [...editor.element.querySelectorAll<HTMLElement>('.ash-chat-code-reference-icon')];
	assert.equal(icons().length, 4);
	assert.equal(icons().filter(icon => icon.classList.contains('placeholder')).length, 3);
	assert.ok(icons().every(icon => icon.getAttribute('aria-hidden') === 'true' && !icon.querySelector('button')));
	assert.equal(editor.element.querySelector<HTMLElement>('[data-file-icon]')?.dataset.fileIcon, '/workspace/settings.json:first');
	version = 'second';
	changed.fire();
	assert.equal(editor.element.querySelector<HTMLElement>('[data-file-icon]')?.dataset.fileIcon, '/workspace/settings.json:second');
	assert.equal(editor.value, 'file output debug anonymous ');
	references.removeReference('file');
	assert.equal(icons().length, 3);
	assert.equal(editor.element.querySelector('[data-file-icon]'), null);
	await editor.getModel().undo();
	assert.equal(icons().length, 4);
	editor.dispose();
	changed.fire();
	assert.equal(dom.window.document.querySelector('.ash-chat-code-reference-icon'), null);
});

test('Reference previews shorten the shared snapshot without exposing output identities or changing submission', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using editorServices = new DisposableStore();
	const services = createChatInputServices(editorServices);
	using editor = services.createInstance(ChatInputEditor, { container: requiredElement<HTMLElement>(dom.window.document, 'main'), placeholder: 'Ask Ash', ariaLabel: 'Chat message', slashCommands: new SlashCommandCatalog([], []), skills: new SkillSelectorCatalog() });
	using references = new ChatDynamicVariableModel(editor);
	const resource = URI.parse('output:/language-server.rust-analyzer.internal-id#3,1-33,1');
	const text = Array.from({ length: 30 }, (_, index) => `Captured line ${index + 1}`).join('\n');
	const content = `Source: ${resource.toString()}\n\n${text}`;
	let acquisitions = 0;
	const entry = references.addReference({ id: 'selection', kind: 'codeSelection', name: 'rust-analyzer (3-32)', resource, resolve: async () => { acquisitions++; return { name: 'rust-analyzer (3-32)', content }; } });
	const hover = () => editor.getModel().getAllDecorations().find(decoration => decoration.options.description === 'chat-context-reference')?.options.hoverMessage as { value: string; } | undefined;
	await waitFor(() => hover()?.value.includes('Captured line 12') === true);
	assert.doesNotMatch(hover()!.value, /internal-id|output:\/|Captured line 13/u);
	assert.match(hover()!.value.replaceAll('&nbsp;', ' '), /Preview shortened/u);
	editor.setSelection({ anchor: 0, active: 0 });
	editor.insertText('Explain ');
	await waitFor(() => hover()?.value.includes('Captured line 12') === true);
	assert.equal((await entry.resolve()).content, content);
	assert.equal(acquisitions, 1);
});

test('Late reference previews cannot restore removed references or decorate another draft', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using editorServices = new DisposableStore();
	const opened: string[] = [];
	const services = createChatInputServices(editorServices, async input => { opened.push(input.resource.toString()); });
	using editor = services.createInstance(ChatInputEditor, { container: requiredElement<HTMLElement>(dom.window.document, 'main'), placeholder: 'Ask Ash', ariaLabel: 'Chat message', slashCommands: new SlashCommandCatalog([], []), skills: new SkillSelectorCatalog() });
	using references = new ChatDynamicVariableModel(editor);
	let finish!: (value: { name: string; content: string; }) => void;
	const pending = new Promise<{ name: string; content: string; }>(resolve => { finish = resolve; });
	references.addReference({ id: 'old', kind: 'codeSelection', name: 'old.ts (1)', resolve: () => pending });
	editor.setSelection({ anchor: 0, active: 0 });
	editor.element.querySelector('.stanza-editor-input')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true }));
	references.removeReference('old');
	references.addReference({ id: 'new', kind: 'codeSelection', name: 'new.ts (1)', resolve: async () => ({ name: 'new.ts (1)', content: 'Current snapshot' }) });
	finish({ name: 'old.ts (1)', content: 'Retired snapshot' });
	await waitFor(() => editor.getModel().getAllDecorations().some(decoration => JSON.stringify(decoration.options.hoverMessage).includes('Current snapshot')));
	assert.equal(editor.getModel().getAllDecorations().filter(decoration => decoration.options.description === 'chat-context-reference').length, 1);
	assert.doesNotMatch(JSON.stringify(editor.getModel().getAllDecorations().map(decoration => decoration.options.hoverMessage)), /Retired snapshot/u);
	assert.deepEqual(opened, []);
});

test('Opening saved references isolates same-name snapshots and reuses the same snapshot tab', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using editorServices = new DisposableStore();
	const opened: import('../../../../common/editor.js').IResourceEditorInput[] = [];
	const services = createChatInputServices(editorServices, async input => { opened.push(input); });
	using editor = services.createInstance(ChatInputEditor, { container: requiredElement<HTMLElement>(dom.window.document, 'main'), placeholder: 'Ask Ash', ariaLabel: 'Chat message', slashCommands: new SlashCommandCatalog([], []), skills: new SkillSelectorCatalog() });
	using references = new ChatDynamicVariableModel(editor);
	for (const content of ['First saved version', 'Second saved version']) {
		references.addReference({ id: 'same-file', kind: 'file', name: 'same.ts', resource: URI.file('/same.ts'), resolve: async () => ({ name: 'same.ts', content }) });
	}
	const open = async (index: number, count: number): Promise<void> => {
		const offset = references.variables[index]!.reference!.start;
		editor.setSelection({ anchor: offset, active: offset });
		editor.element.querySelector('.stanza-editor-input')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true }));
		await waitFor(() => opened.length === count);
	};
	await open(0, 1);
	await open(1, 2);
	await open(0, 3);
	assert.deepEqual(opened.map(input => input.initialText), ['First saved version', 'Second saved version', 'First saved version']);
	assert.notEqual(opened[0]!.resource.toString(), opened[1]!.resource.toString());
	assert.equal(opened[0]!.resource.toString(), opened[2]!.resource.toString());
	assert.ok(opened.every(input => input.readOnly && input.resource.scheme === 'chat-context-snapshot' && !input.showBreadcrumbs));
	assert.equal(references.variables.length, 2);
});

test('Inline code references track edits, atomic deletion, undo and redo in the real Chat editor', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using editorServices = new DisposableStore();
	const services = createChatInputServices(editorServices);
	using editor = services.createInstance(ChatInputEditor, { container: requiredElement<HTMLElement>(dom.window.document, 'main'), placeholder: 'Ask Ash', ariaLabel: 'Chat message', slashCommands: new SlashCommandCatalog([], []), skills: new SkillSelectorCatalog() });
	using references = new ChatDynamicVariableModel(editor);
	editor.value = 'Explain  please';
	editor.setSelection({ anchor: 8, active: 8 });
	references.addReference({ id: 'selection', kind: 'codeSelection', name: 'file.ts (6-9)', resolve: async () => ({ name: 'file.ts (6-9)', content: 'Unsaved code' }) });
	assert.equal(editor.value, 'Explain file.ts (6-9) please');
	assert.deepEqual(references.variables[0]?.reference, { start: 8, end: 21 });
	assert.equal(editor.getModel().getAllDecorations().filter(decoration => decoration.options.before?.replaceLength).length, 1);
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
	const services = createChatInputServices(editorServices);
	const editors = services.get(ICodeEditorService);
	const decorationTypes = editors.listDecorationTypes();
	const lifecycle: string[] = [];
	using willCreate = editors.onWillCreateCodeEditor(() => lifecycle.push('will'));
	using added = editors.onCodeEditorAdd(() => lifecycle.push('add'));
	using removed = editors.onCodeEditorRemove(() => lifecycle.push('remove'));
	using editor = services.createInstance(ChatInputEditor, { container: requiredElement<HTMLElement>(dom.window.document, "main"), placeholder: "Ask Ash", ariaLabel: "Chat message", slashCommands: new SlashCommandCatalog(DesktopSlashCommands, []), skills: new SkillSelectorCatalog() });
	assert.ok(editors.listDecorationTypes().includes(dynamicVariableDecorationType));
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
	assert.deepEqual(editors.listDecorationTypes(), decorationTypes);
	assert.equal(editors.listCodeEditors().length, 0);
	assert.deepEqual(lifecycle, ['will', 'add', 'remove']);
});

test('Chat typography updates preserve the draft and selection, resize the input, and reset independently of file fonts', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using editorServices = new DisposableStore();
	const services = createChatInputServices(editorServices);
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
	using editor = createChatInputServices(editorServices).createInstance(ChatInputEditor, { container, placeholder: "Ask Ash", ariaLabel: "Chat message", slashCommands: new SlashCommandCatalog(DesktopSlashCommands, []), skills: new SkillSelectorCatalog() });
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
	using editor = createChatInputServices(editorServices).createInstance(ChatInputEditor, {
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
	using editor = createChatInputServices(editorServices).createInstance(ChatInputEditor, {
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

test('Chat input discovers Skills through the shared `$` selector', async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement<HTMLElement>(dom.window.document, "main");
	const catalog = new SlashCommandCatalog(DesktopSlashCommands, []);
	const skills = new SkillSelectorCatalog();
	using editorServices = new DisposableStore();
	const services = createChatInputServices(editorServices);
	const options = { container, placeholder: "Ask Ash", ariaLabel: "Chat message", slashCommands: catalog, skills };
	using editor = services.createInstance(ChatInputEditor, options);
	let submissions = 0;
	using submitListener = editor.onDidSubmit(() => submissions++);
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
	assert.equal(submissions, 0);
});

test('Chat command completion replaces the whole command and preserves arguments', async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement<HTMLElement>(dom.window.document, "main");
	using editorServices = new DisposableStore();
	const services = createChatInputServices(editorServices);
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
	using editor = createChatInputServices(editorServices).createInstance(ChatInputEditor, { container, placeholder: "Ask Ash", ariaLabel: "Chat message", slashCommands: new SlashCommandCatalog(DesktopSlashCommands, []), skills: new SkillSelectorCatalog() });
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

function createChatInputServices(resources: DisposableStore, openEditor: import('../../../../services/editor/common/editorService.js').IEditorService['openEditor'] = async () => { }): ReturnType<typeof createCodeEditorServices> {
	const services = createCodeEditorServices(resources);
	services.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor, focusActiveEditor() { } });
	services.registerInstance(IResourceIconRenderer, { onDidChangeResourceIcons: AshEvent.None, getFileIconTheme: () => noFileIconTheme, renderFileIcon() { } });
	services.registerInstance(IChatSessionNavigationService, {
		revision: 0,
		getConversations: () => [],
		getActiveConversation: () => undefined,
		appendToActiveDraft() { throw new Error('Unexpected draft handoff'); },
		captureActiveDraft: async () => undefined,
		openConversation: async () => { throw new Error('Unexpected conversation navigation'); },
		startVoiceConversation: async () => { throw new Error('Unexpected voice start'); },
	});
	return services;
}
