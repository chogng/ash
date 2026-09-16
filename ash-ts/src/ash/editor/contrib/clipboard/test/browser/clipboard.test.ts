import { StandaloneCodeEditorService } from '../../../../standalone/browser/standaloneCodeEditorService.js';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { Selection } from '../../../../common/core/selection.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { MenuId, MenusRegistry } from '../../../../../platform/actions/common/actions.js';
import { IClipboardService, type IClipboardService as IClipboardServiceContract } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ContextKeyService, IContextKeyService } from "../../../../../platform/contextkey/browser/contextKeyService.js";
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { ICodeEditorService } from '../../../../browser/services/codeEditorService.js';

const environment = new JSDOM('<!doctype html><body></body>');
for (const [name, value] of Object.entries({
	window: environment.window,
	document: environment.window.document,
	navigator: { userAgent: environment.window.navigator.userAgent, clipboard: {} },
	Node: environment.window.Node,
	Element: environment.window.Element,
	HTMLElement: environment.window.HTMLElement,
	Event: environment.window.Event,
	InputEvent: environment.window.InputEvent,
	KeyboardEvent: environment.window.KeyboardEvent,
	MouseEvent: environment.window.MouseEvent,
	ResizeObserver: class TestResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} },
})) Object.defineProperty(globalThis, name, { configurable: true, value });

const { CodeEditorWidget } = await import('../../../../browser/widget/codeEditor/codeEditorWidget.js');
const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');
const { createEditorBrowserServices } = await import('../../../../browser/services/contribution.js');
const { CopyAction, CutAction, PasteAction } = await import('../../browser/clipboard.js');
assert.ok(CopyAction);
assert.ok(CutAction);
assert.ok(PasteAction);

suiteTeardown(() => environment.window.close());

test('clipboard actions use the focused code editor and platform clipboard service', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using model = new TextModel('alpha beta');
	using services = new ServiceContainer();
	using contextKeys = new ContextKeyService();
	const browserServices = createEditorBrowserServices(new StandaloneCodeEditorService());
	const clipboard = new MemoryClipboardService();
	services.registerInstance(IContextKeyService, contextKeys);
	services.registerInstance(ILogService, new NullLoggerService());
	services.registerInstance(IClipboardService, clipboard);
	services.registerInstance(ICodeEditorService, browserServices.codeEditorService);
	using editor = createTestCodeEditor({
		container,
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
		instantiationService: services,
		codeEditorService: browserServices.codeEditorService,
	});
	editor.focus();
	editor.setSelection(new Selection(1, 1, 1, 6));
	await CopyAction.runCommand(services, undefined);
	assert.equal(clipboard.text, 'alpha');

	clipboard.text = 'omega';
	await PasteAction.runCommand(services, undefined);
	assert.equal(model.getText(), 'omega beta');

	editor.setSelection(new Selection(1, 1, 1, 6));
	await CutAction.runCommand(services, undefined);
	assert.equal(clipboard.text, 'omega');
	assert.equal(model.getText(), ' beta');
	dom.window.close();
});

test('paste command drops a delayed clipboard read after focus, selection, or model changes', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main><aside></aside></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using firstModel = new TextModel('alpha');
	using secondModel = new TextModel('bravo');
	using services = new ServiceContainer();
	using contextKeys = new ContextKeyService();
	const browserServices = createEditorBrowserServices(new StandaloneCodeEditorService());
	const clipboard = new DeferredClipboardService();
	services.registerInstance(IContextKeyService, contextKeys);
	services.registerInstance(ILogService, new NullLoggerService());
	services.registerInstance(IClipboardService, clipboard);
	services.registerInstance(ICodeEditorService, browserServices.codeEditorService);
	using first = createTestCodeEditor({
		container: dom.window.document.querySelector<HTMLElement>('main')!,
		model: firstModel,
		input: { resource: firstModel.uri },
		languageId: firstModel.getLanguageId(),
		lineHeight: 20,
		instantiationService: services,
		codeEditorService: browserServices.codeEditorService,
	});
	using second = createTestCodeEditor({
		container: dom.window.document.querySelector<HTMLElement>('aside')!,
		model: secondModel,
		input: { resource: secondModel.uri },
		languageId: secondModel.getLanguageId(),
		lineHeight: 20,
		instantiationService: services,
		codeEditorService: browserServices.codeEditorService,
	});

	first.focus();
	first.setSelection(new Selection(1, 6, 1, 6));
	const afterFocus = PasteAction.runCommand(services, undefined);
	assert.equal(clipboard.readRequestCount, 1);
	second.focus();
	clipboard.resolveRead(0, 'X');
	await afterFocus;
	assert.deepEqual([firstModel.getText(), secondModel.getText()], ['alpha', 'bravo']);

	first.focus();
	const afterSelection = PasteAction.runCommand(services, undefined);
	first.setSelection(new Selection(1, 1, 1, 1));
	clipboard.resolveRead(1, 'Y');
	await afterSelection;
	assert.equal(firstModel.getText(), 'alpha');

	first.setSelection(new Selection(1, 6, 1, 6));
	const afterModelChange = PasteAction.runCommand(services, undefined);
	firstModel.setValue('changed');
	clipboard.resolveRead(2, 'Z');
	await afterModelChange;
	assert.equal(firstModel.getText(), 'changed');

	for (const change of ['selection', 'focus', 'readonly', 'escape'] as const) {
		first.focus();
		first.setSelection(new Selection(1, 1, 1, 1));
		const request = clipboard.readRequestCount;
		const pending = PasteAction.runCommand(services, undefined);
		if (change === 'selection') {
			first.setSelection(new Selection(1, 3, 1, 3));
			first.setSelection(new Selection(1, 1, 1, 1));
		} else if (change === 'focus') {
			second.focus();
			first.focus();
		} else if (change === 'readonly') {
			first.updateOptions({ readOnly: true });
			first.updateOptions({ readOnly: false });
		} else {
			first.getContainerDomNode().querySelector('.stanza-editor-input')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		}
		clipboard.resolveRead(request, 'stale');
		await pending;
		assert.equal(firstModel.getText(), 'changed', change);
	}

	first.setSelection(new Selection(1, 8, 1, 8));
	const validPaste = PasteAction.runCommand(services, undefined);
	clipboard.resolveRead(clipboard.readRequestCount - 1, '!');
	await validPaste;
	assert.equal(firstModel.getText(), 'changed!');

	using replacement = new TextModel('replacement');
	const afterModelSwitch = PasteAction.runCommand(services, undefined);
	first.setModel(replacement);
	assert.equal(first.hasTextFocus(), true);
	clipboard.resolveRead(clipboard.readRequestCount - 1, '?');
	await afterModelSwitch;
	assert.deepEqual([firstModel.getText(), replacement.getText()], ['changed!', 'replacement']);
	dom.window.close();
});

test('cut command keeps text when clipboard writing completes after selection or focus changes', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main><aside></aside></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	dom.window.document.execCommand = () => true;
	using firstModel = new TextModel('alpha beta');
	using secondModel = new TextModel('bravo');
	using services = new ServiceContainer();
	using contextKeys = new ContextKeyService();
	const browserServices = createEditorBrowserServices(new StandaloneCodeEditorService());
	const clipboard = new DeferredClipboardService();
	services.registerInstance(IContextKeyService, contextKeys);
	services.registerInstance(ILogService, new NullLoggerService());
	services.registerInstance(IClipboardService, clipboard);
	services.registerInstance(ICodeEditorService, browserServices.codeEditorService);
	using first = createTestCodeEditor({
		container: dom.window.document.querySelector<HTMLElement>('main')!,
		model: firstModel,
		input: { resource: firstModel.uri },
		languageId: firstModel.getLanguageId(),
		lineHeight: 20,
		instantiationService: services,
		codeEditorService: browserServices.codeEditorService,
	});
	using second = createTestCodeEditor({
		container: dom.window.document.querySelector<HTMLElement>('aside')!,
		model: secondModel,
		input: { resource: secondModel.uri },
		languageId: secondModel.getLanguageId(),
		lineHeight: 20,
		instantiationService: services,
		codeEditorService: browserServices.codeEditorService,
	});

	first.focus();
	first.setSelection(new Selection(1, 1, 1, 6));
	const afterSelection = CutAction.runCommand(services, undefined);
	assert.equal(clipboard.writtenTexts[0], 'alpha');
	first.setSelection(new Selection(1, 7, 1, 11));
	clipboard.resolveWrite(0);
	await afterSelection;
	assert.equal(firstModel.getText(), 'alpha beta');

	first.setSelection(new Selection(1, 1, 1, 6));
	const afterFocus = CutAction.runCommand(services, undefined);
	second.focus();
	clipboard.resolveWrite(1);
	await afterFocus;
	assert.deepEqual([firstModel.getText(), secondModel.getText()], ['alpha beta', 'bravo']);

	for (const change of ['selection', 'focus', 'readonly', 'escape'] as const) {
		first.focus();
		first.setSelection(new Selection(1, 1, 1, 6));
		const pending = CutAction.runCommand(services, undefined);
		if (change === 'selection') {
			first.setSelection(new Selection(1, 7, 1, 11));
			first.setSelection(new Selection(1, 1, 1, 6));
		} else if (change === 'focus') {
			second.focus();
			first.focus();
		} else if (change === 'readonly') {
			first.updateOptions({ readOnly: true });
			first.updateOptions({ readOnly: false });
		} else {
			first.getContainerDomNode().querySelector('.stanza-editor-input')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		}
		clipboard.resolveWrite(clipboard.writtenTexts.length - 1);
		await pending;
		assert.equal(firstModel.getText(), 'alpha beta', change);
	}

	first.focus();
	first.setSelection(new Selection(1, 1, 1, 6));
	const validCut = CutAction.runCommand(services, undefined);
	clipboard.resolveWrite(clipboard.writtenTexts.length - 1);
	await validCut;
	assert.equal(firstModel.getText(), ' beta');
	dom.window.close();
});

test('clipboard actions contribute the standard editor and simple-editor menu commands', () => {
	for (const menuId of [MenuId.EditorContext, MenuId.SimpleEditorContext]) {
		const commandIds = MenusRegistry.getMenuItems(menuId)
			.filter(item => 'command' in item)
			.map(item => item.command.id);
		assert.equal(commandIds.includes(CutAction.id), true);
		assert.equal(commandIds.includes(CopyAction.id), true);
		assert.equal(commandIds.includes(PasteAction.id), true);
	}
});

class MemoryClipboardService implements IClipboardServiceContract {
	text = '';
	async readText(): Promise<string> { return this.text; }
	async writeText(value: string): Promise<void> { this.text = value; }
}

class DeferredClipboardService implements IClipboardServiceContract {
	private readonly reads: Array<(text: string) => void> = [];
	private readonly writes: Array<() => void> = [];
	readonly writtenTexts: string[] = [];

	get readRequestCount(): number { return this.reads.length; }

	readText(): Promise<string> {
		return new Promise(resolve => this.reads.push(resolve));
	}

	writeText(text: string): Promise<void> {
		this.writtenTexts.push(text);
		return new Promise(resolve => this.writes.push(resolve));
	}

	resolveRead(index: number, text: string): void {
		this.reads[index]?.(text);
	}

	resolveWrite(index: number): void {
		this.writes[index]?.();
	}
}
