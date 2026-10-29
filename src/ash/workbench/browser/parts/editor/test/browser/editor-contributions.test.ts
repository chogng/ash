import { StatusbarService } from '../../../statusbar/statusbarPart.js';
import { IFileTextModelService } from '../../../../../services/textmodelResolver/common/textModelResourceService.js';
import '../../../../../../editor/test/browser/testEditorDom.js';
import { TestUriIdentityServices } from '../../../../../../platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { createTestComponentServices } from '../../../../../test/common/testEditorServices.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { SaveReason, type ISaveOptions } from '../../../../../common/editor.js';
import type { IResourceEditorInput, IEditorPane, EditorPaneStatus } from '../../../../../common/editor.js';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { IAccessibilityService } from '../../../../../../platform/accessibility/common/accessibility.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { InMemoryConfigurationService } from '../../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { BrowserWorkingCopyService } from '../../../../../services/workingCopy/browser/browserWorkingCopyService.js';
import type { IWorkingCopy } from '../../../../../services/workingCopy/common/workingCopyService.js';
import { StatusbarAlignment } from '../../../../../services/statusbar/browser/statusbar.js';
import { EditorAutoSaveConfiguration, EditorAutoSaveDelayConfiguration } from '../../../../../services/editor/common/editorConfiguration.js';
import { EditorPane } from '../../editorPane.js';

import type { IEditorPart } from '../../editorPart.js';
import { EditorAutoSave } from '../../editorAutoSave.js';
import { ChangeEOLAction, ChangeLanguageAction, EditorStatusContribution } from '../../editorStatus.js';

import { TextModel } from '../../../../../../editor/common/model/textModel.js';
import { Range } from '../../../../../../editor/common/core/range.js';
import { ICodeEditorService } from '../../../../../../editor/browser/services/codeEditorService.js';
import { ILanguageService } from '../../../../../../editor/common/languages/language.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { registerAction2 } from '../../../../../../platform/actions/common/actions.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../../services/localization/common/localizationCatalogs.js';
const { createCodeEditorServices, createTestCodeEditor } = await import('../../../../../../editor/test/browser/testCodeEditor.js');
await import('../../../../../../editor/editor.code.all.js');
registerAction2(ChangeLanguageAction);
registerAction2(ChangeEOLAction);

const uriIdentityServices = new TestUriIdentityServices();
suiteTeardown(() => uriIdentityServices.dispose());

test('EditorAutoSave saves dirty copies after the configured delay and skips conflicts', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const editorChanges = new Emitter<void>();
	const editorPart = {
		domNode: dom.window.document.body,
		activePane: undefined,
		onDidChangeEditors: editorChanges.event,
	} as unknown as IEditorPart;
	const configuration = new InMemoryConfigurationService();
	await configuration.updateValue(EditorAutoSaveConfiguration, 'afterDelay');
	await configuration.updateValue(EditorAutoSaveDelayConfiguration, 100);
	using workingCopies = uriIdentityServices.createInstance(BrowserWorkingCopyService);
	using workingCopy = new TestWorkingCopy(URI.file('C:\\project\\auto-save.ts'));
	using registration = workingCopies.register(workingCopy);
	using contribution = new EditorAutoSave(editorPart, workingCopies, configuration);

	workingCopy.markDirty();
	await waitFor(() => workingCopy.saveCount === 1);
	assert.deepEqual(workingCopy.saveReasons, [SaveReason.AUTO]);
	workingCopy.setExternalChange(true);
	workingCopy.markDirty();
	workingCopy.fireContentChange();
	await delay(130);
	assert.equal(workingCopy.saveCount, 1);

	editorChanges.dispose();
	configuration.dispose();
	dom.window.close();
});

test('EditorAutoSave observes auxiliary editor window blur', async () => {
	const main = new JSDOM('<!doctype html><body></body>');
	const auxiliary = new JSDOM('<!doctype html><body></body>');
	const editorChanges = new Emitter<void>();
	const state = { domNode: main.window.document.body };
	const editorPart = {
		get domNode() { return state.domNode; },
		activePane: undefined,
		onDidChangeEditors: editorChanges.event,
	} as unknown as IEditorPart;
	const configuration = new InMemoryConfigurationService();
	await configuration.updateValue(EditorAutoSaveConfiguration, 'onWindowChange');
	using workingCopies = uriIdentityServices.createInstance(BrowserWorkingCopyService);
	using workingCopy = new TestWorkingCopy(URI.file('C:\\project\\auxiliary-auto-save.ts'));
	using registration = workingCopies.register(workingCopy);
	using contribution = new EditorAutoSave(editorPart, workingCopies, configuration);

	state.domNode = auxiliary.window.document.body;
	editorChanges.fire();
	workingCopy.markDirty();
	auxiliary.window.dispatchEvent(new auxiliary.window.Event('blur'));
	await waitFor(() => workingCopy.saveCount === 1);
	assert.deepEqual(workingCopy.saveReasons, [SaveReason.WINDOW_CHANGE]);

	editorChanges.dispose();
	configuration.dispose();
	main.window.close();
	auxiliary.window.close();
});

test('EditorAutoSave saves dirty working copies when focus mode loses window focus', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const editorChanges = new Emitter<void>();
	const editorPart = {
		domNode: dom.window.document.body,
		activePane: undefined,
		onDidChangeEditors: editorChanges.event,
	} as unknown as IEditorPart;
	const configuration = new InMemoryConfigurationService();
	await configuration.updateValue(EditorAutoSaveConfiguration, 'onFocusChange');
	using workingCopies = uriIdentityServices.createInstance(BrowserWorkingCopyService);
	using workingCopy = new TestWorkingCopy(URI.file('C:\\project\\focus-auto-save.ts'));
	using registration = workingCopies.register(workingCopy);
	using contribution = new EditorAutoSave(editorPart, workingCopies, configuration);

	workingCopy.markDirty();
	dom.window.dispatchEvent(new dom.window.Event('blur'));
	await waitFor(() => workingCopy.saveCount === 1);
	assert.deepEqual(workingCopy.saveReasons, [SaveReason.FOCUS_CHANGE]);

	editorChanges.dispose();
	configuration.dispose();
	dom.window.close();
});

test('EditorAutoSave saves existing dirty working copies when auto save is enabled', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const editorChanges = new Emitter<void>();
	const editorPart = {
		domNode: dom.window.document.body,
		activePane: undefined,
		onDidChangeEditors: editorChanges.event,
	} as unknown as IEditorPart;
	const configuration = new InMemoryConfigurationService();
	using workingCopies = uriIdentityServices.createInstance(BrowserWorkingCopyService);
	using workingCopy = new TestWorkingCopy(URI.file('C:\\project\\enabled-auto-save.ts'));
	using registration = workingCopies.register(workingCopy);
	using untitled = new TestWorkingCopy(URI.parse('untitled:/draft'));
	using untitledRegistration = workingCopies.register(untitled);
	using contribution = new EditorAutoSave(editorPart, workingCopies, configuration);

	workingCopy.markDirty();
	untitled.markDirty();
	await configuration.updateValue(EditorAutoSaveConfiguration, 'onFocusChange');
	await waitFor(() => workingCopy.saveCount === 1);
	dom.window.dispatchEvent(new dom.window.Event('blur'));
	assert.equal(untitled.saveCount, 0);

	editorChanges.dispose();
	configuration.dispose();
	dom.window.close();
});

test('EditorAutoSave clears a delay timer through the window that created it', async () => {
	const main = new JSDOM('<!doctype html><body></body>');
	const auxiliary = new JSDOM('<!doctype html><body></body>');
	const editorChanges = new Emitter<void>();
	const state = { domNode: main.window.document.body };
	const editorPart = {
		get domNode() { return state.domNode; },
		activePane: undefined,
		onDidChangeEditors: editorChanges.event,
	} as unknown as IEditorPart;
	const configuration = new InMemoryConfigurationService();
	await configuration.updateValue(EditorAutoSaveConfiguration, 'afterDelay');
	await configuration.updateValue(EditorAutoSaveDelayConfiguration, 100);
	using workingCopies = uriIdentityServices.createInstance(BrowserWorkingCopyService);
	using workingCopy = new TestWorkingCopy(URI.file('C:\\project\\window-timer.ts'));
	using registration = workingCopies.register(workingCopy);
	using contribution = new EditorAutoSave(editorPart, workingCopies, configuration);

	workingCopy.markDirty();
	state.domNode = auxiliary.window.document.body;
	editorChanges.fire();
	await configuration.updateValue(EditorAutoSaveConfiguration, 'off');
	await delay(130);
	assert.equal(workingCopy.saveCount, 0);

	editorChanges.dispose();
	configuration.dispose();
	main.window.close();
	auxiliary.window.close();
});

test('EditorStatusContribution projects and clears active pane status', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const editorChanges = new Emitter<void>();
	const workingCopy = new TestWorkingCopy(URI.file('C:\\project\\status.ts'));
	const pane = new TestStatusPane(dom.window.document, workingCopy);
	const input: IResourceEditorInput = { resource: workingCopy.resource, languageId: 'typescript' };
	const state: { activeInput: IResourceEditorInput | undefined; activePane: IEditorPane | undefined; } = { activeInput: input, activePane: pane };
	const editorPart = {
		domNode: dom.window.document.body,
		get activeInput() { return state.activeInput; },
		get activePane() { return state.activePane; },
		onDidChangeEditors: editorChanges.event,
	} as unknown as IEditorPart;
	using statusbar = new StatusbarService();
	using contribution = new EditorStatusContribution(editorPart, statusbar, {
		onDidChangeScreenReaderOptimized: Event.None,
		isScreenReaderOptimized: () => false,
	} as unknown as IAccessibilityService, emptyCodeEditors, emptyCommands, testLanguages, emptyQuickInput, emptyFileModels);

	assert.deepEqual(statusTexts(statusbar), ['TypeScript', 'LF', 'UTF-8', 'Ln 4, Col 9']);
	state.activeInput = { ...input, readOnly: true };
	editorChanges.fire();
	assert.equal(statusTexts(statusbar)[0], 'Read-only');
	using welcomePane = new TestStatusPane(dom.window.document, undefined);
	state.activeInput = { resource: URI.parse('ash-welcome:/welcome'), readOnly: true };
	state.activePane = welcomePane;
	editorChanges.fire();
	assert.ok(!statusTexts(statusbar).includes('Read-only'));
	state.activeInput = input;
	state.activePane = pane;
	editorChanges.fire();
	workingCopy.markDirty();
	editorChanges.fire();
	assert.deepEqual(statusTexts(statusbar), ['TypeScript', 'LF', 'UTF-8', 'Ln 4, Col 9']);
	state.activeInput = { ...input, readOnly: true };
	editorChanges.fire();
	assert.equal(statusTexts(statusbar)[0], 'Read-only');
	state.activeInput = input;
	editorChanges.fire();
	workingCopy.setExternalChange(true);
	editorChanges.fire();
	assert.equal(statusTexts(statusbar)[0], 'Conflict');
	pane.setStatus({ lineNumber: 10, columnNumber: 2, selectionCount: 3, languageId: 'json', encoding: 'UTF-8', endOfLine: 'CRLF' });
	assert.deepEqual(statusTexts(statusbar), ['Conflict', 'JSON', 'CRLF', 'UTF-8', '3 selections']);

	state.activeInput = undefined;
	state.activePane = undefined;
	editorChanges.fire();
	assert.deepEqual(statusTexts(statusbar), []);

	pane.dispose();
	workingCopy.dispose();
	editorChanges.dispose();
	dom.window.close();
});

test('EditorStatusContribution explains screen reader mode and restores focus', () => {
	const dom = new JSDOM("<!doctype html><body><button id='previous'>Previous</button></body>");
	const changes = new Emitter<void>();
	let optimized = false;
	const accessibility = {
		onDidChangeScreenReaderOptimized: changes.event,
		isScreenReaderOptimized: () => optimized,
	} as unknown as IAccessibilityService;
	const editorPart = {
		domNode: dom.window.document.body,
		activeInput: undefined,
		activePane: undefined,
		onDidChangeEditors: Event.None,
	} as unknown as IEditorPart;
	using statusbar = new StatusbarService();
	using contribution = new EditorStatusContribution(editorPart, statusbar, accessibility, emptyCodeEditors, emptyCommands, testLanguages, emptyQuickInput, emptyFileModels);
	assert.equal(statusTexts(statusbar).length, 0);

	optimized = true;
	changes.fire();
	const entry = statusbar.getEntries(StatusbarAlignment.Right)[0]?.entry;
	assert.equal(entry?.text, 'Screen Reader Mode');
	const previous = dom.window.document.querySelector<HTMLButtonElement>('#previous')!;
	previous.focus();
	entry?.run?.();
	const dialog = dom.window.document.querySelector<HTMLElement>('.ash-screen-reader-explanation');
	assert.equal(dialog?.getAttribute('role'), 'dialog');
	assert.equal(dom.window.document.activeElement?.textContent, 'Close');
	assert.match(dialog?.textContent ?? '', /Screen reader optimization/);
	assert.equal(dialog?.getAttribute('aria-labelledby'), dialog?.querySelector('h2')?.id);
	(dialog?.querySelector('button') as HTMLButtonElement).dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	assert.equal(dom.window.document.querySelector('.ash-screen-reader-explanation'), null);
	assert.equal(dom.window.document.activeElement, previous);

	entry?.run?.();
	optimized = false;
	changes.fire();
	assert.equal(statusTexts(statusbar).length, 0);
	assert.equal(dom.window.document.querySelector('.ash-screen-reader-explanation'), null);
	changes.dispose();
	dom.window.close();
});

class TestWorkingCopy extends Disposable implements IWorkingCopy {
	private readonly dirtyEmitter = this._register(new Emitter<void>());
	private readonly externalEmitter = this._register(new Emitter<void>());
	private readonly contentEmitter = this._register(new Emitter<void>());
	private dirty = false;
	private external = false;
	readonly backupKind = 'text' as const;
	readonly onDidChangeDirty = this.dirtyEmitter.event;
	readonly onDidChangeExternalChange = this.externalEmitter.event;
	readonly onDidChangeContent = this.contentEmitter.event;
	saveCount = 0;

	constructor(readonly resource: URI) { super(); }
	get isDirty(): boolean { return this.dirty; }
	get hasExternalChange(): boolean { return this.external; }
	backup(): string { return 'content'; }
	restoreBackup(): void { this.markDirty(); }
	markDirty(): void { this.dirty = true; this.dirtyEmitter.fire(); }
	setExternalChange(value: boolean): void { this.external = value; this.externalEmitter.fire(); }
	fireContentChange(): void { this.contentEmitter.fire(); }
	readonly saveReasons: SaveReason[] = [];
	async save(_signal?: AbortSignal, options?: ISaveOptions): Promise<void> { this.saveReasons.push(options?.reason ?? SaveReason.EXPLICIT); this.saveCount += 1; this.dirty = false; this.dirtyEmitter.fire(); }
	async saveAs(): Promise<void> { await this.save(); }
	async revert(): Promise<void> { this.dirty = false; this.dirtyEmitter.fire(); }
}

class TestStatusPane extends EditorPane implements IEditorPane {
	readonly id = 'test.status';
	private readonly statusEmitter = this._register(new Emitter<void>());
	readonly onDidChangeStatus = this.statusEmitter.event;
	private status: EditorPaneStatus = { lineNumber: 4, columnNumber: 9, languageId: 'typescript', encoding: 'UTF-8', endOfLine: 'LF' };

	constructor(document: Document, readonly workingCopy: IWorkingCopy | undefined) {
		const services = createTestComponentServices(undefined, undefined, document);
		super('test.status', services.get(IThemeService), services.get(IStorageService));
		this._register(services);
	}
	getStatus(): EditorPaneStatus { return this.status; }
	setStatus(status: EditorPaneStatus): void { this.status = status; this.statusEmitter.fire(); }
	public override create(parent: HTMLElement): void {
		super.create(parent);
	}
	public override async setInput(): Promise<void> { }
	public override clearInput(): void { }
	public override layout(): void { }
	public override focus(): void { }
}

function statusTexts(statusbar: StatusbarService): string[] {
	return statusbar.getEntries(StatusbarAlignment.Right).map(item => item.entry.text);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('Timed out waiting for editor contribution state');
		await delay(5);
	}
}

const emptyCodeEditors = { onCodeEditorAdd: Event.None, onCodeEditorRemove: Event.None, listCodeEditors: () => [], listDiffEditors: () => [] } as unknown as import('../../../../../../editor/browser/services/codeEditorService.js').ICodeEditorService;
const emptyCommands = { executeCommand: async () => undefined } as unknown as import('../../../../../../platform/commands/common/commands.js').ICommandService;
const testLanguages = { onDidChange: Event.None, getLanguageName: (id: string) => ({ typescript: 'TypeScript', json: 'JSON' })[id] ?? id } as unknown as import('../../../../../../editor/common/languages/language.js').IAshLanguageService;
const emptyFileModels = { onDidChangeEncoding: Event.None, getModel: () => null, getEncodingSupport: () => undefined } as unknown as IFileTextModelService;
const emptyQuickInput = {} as import('../../../../../../platform/quickinput/common/quickInput.js').IQuickInputService;

test('Editor status actions update the real model and clear when the active editor closes', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using resources = new DisposableStore();
	const parentServices = createCodeEditorServices(resources);
	const services = resources.add(parentServices.createChild());
	services.registerInstance(IFileTextModelService, emptyFileModels);
	using model = new TextModel('\talpha\r\nbeta', { languageId: 'plaintext' });
	using editor = createTestCodeEditor({ container: dom.window.document.querySelector('main')!, model, instantiationService: services });
	using editorChanges = new Emitter<void>();
	let active = true;
	const pane = { getControl: () => editor } as unknown as IEditorPane;
	const editorPart = {
		domNode: dom.window.document.body,
		get activeInput() { return active ? { resource: URI.file('/status.txt') } : undefined; },
		get activePane() { return active ? pane : undefined; },
		onDidChangeEditors: editorChanges.event,
	} as unknown as IEditorPart;
	using statusbar = new StatusbarService();
	using contribution = services.createInstance(EditorStatusContribution, editorPart, statusbar);
	const entry = (suffix: string) => statusbar.getEntries(StatusbarAlignment.Right).find(item => item.id === `ash.status.editor.${suffix}`)!.entry;
	assert.equal(entry('eol').text, 'CRLF');
	model.updateOptions({ tabSize: 4, indentSize: 4, insertSpaces: false });
	editor.setSelection(new Range(1, 2, 1, 2));
	assert.equal(entry('cursor').text, 'Ln 1, Col 5');
	assert.equal(entry('indentation').text, 'Tab Size: 4');
	editor.setSelection(new Range(1, 2, 1, 4));
	assert.equal(entry('cursor').text, 'Ln 1, Col 7 (2 selected)');
	using language = services.get(ILanguageService).registerLanguage({ id: 'status-language', aliases: ['Status Language'] });
	await services.get(ICommandService).executeCommand(ChangeLanguageAction.ID, 'status-language');
	assert.equal(model.getLanguageId(), 'status-language');
	assert.equal(entry('language').text, 'Status Language');

	const changeEOL = Promise.resolve(entry('eol').run!());
	const quickInput = services.get(IQuickInputService);
	assert.ok(quickInput.currentQuickInput);
	const input = globalThis.document.querySelector<HTMLInputElement>('.ash-quick-input-host input')!;
	assert.ok(input);
	input.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
	await changeEOL;
	assert.equal(model.getEOL(), '\n');
	assert.equal(entry('eol').text, 'LF');
	model.undo();
	assert.equal(model.getEOL(), '\r\n');
	assert.equal(entry('eol').text, 'CRLF');

	const changeIndentation = Promise.resolve(entry('indentation').run!());
	const indentInput = globalThis.document.querySelector<HTMLInputElement>('.ash-quick-input-host input')!;
	indentInput.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
	await Promise.resolve();
	const sizeInput = globalThis.document.querySelector<HTMLInputElement>('.ash-quick-input-host input')!;
	sizeInput.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
	sizeInput.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
	await changeIndentation;
	assert.equal(model.getOptions().insertSpaces, true);
	assert.equal(model.getOptions().tabSize, 2);
	assert.equal(entry('indentation').text, 'Spaces: 2');

	editor.updateOptions({ readOnly: true });
	assert.equal(entry('eol').run, undefined);
	await services.get(ICommandService).executeCommand('workbench.action.editor.changeEOL');
	assert.equal(quickInput.currentQuickInput, undefined);
	editor.updateOptions({ readOnly: false });
	const staleChange = Promise.resolve(entry('eol').run!());
	using replacement = new TextModel('\uFEFFreplacement');
	editor.setModel(replacement);
	assert.equal(entry('encoding').text, 'UTF-8 with BOM');
	globalThis.document.querySelector<HTMLInputElement>('.ash-quick-input-host input')!.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
	await staleChange;
	assert.equal(model.getEOL(), '\r\n');
	assert.equal(replacement.getEOL(), '\n');
	const pendingIndentation = Promise.resolve(entry('indentation').run!());
	assert.ok(quickInput.currentQuickInput);
	contribution.dispose();
	await pendingIndentation;
	assert.equal(quickInput.currentQuickInput, undefined);
	assert.deepEqual(statusTexts(statusbar), []);

	active = false;
	editorChanges.fire();
	assert.deepEqual(statusTexts(statusbar), []);
	model.setLanguage('plaintext');
	assert.deepEqual(statusTexts(statusbar), []);
});

test('Editor status uses the Chinese language pack', () => {
	using reset = toDisposable(() => resetNlsResolver());
	setNlsMessages('zh-CN', productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
	const dom = new JSDOM('<!doctype html><body></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	using workingCopy = new TestWorkingCopy(URI.file('/status.ts'));
	using pane = new TestStatusPane(dom.window.document, workingCopy);
	const editorPart = { domNode: dom.window.document.body, activeInput: { resource: URI.file('/status.ts') }, activePane: pane, onDidChangeEditors: Event.None } as unknown as IEditorPart;
	using statusbar = new StatusbarService();
	using contribution = new EditorStatusContribution(editorPart, statusbar, { onDidChangeScreenReaderOptimized: Event.None, isScreenReaderOptimized: () => false } as unknown as IAccessibilityService, emptyCodeEditors, emptyCommands, testLanguages, emptyQuickInput, emptyFileModels);
	assert.ok(statusTexts(statusbar).includes('行 4，列 9'));
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right).find(item => item.id === 'ash.status.editor.eol')?.entry.tooltip, '选择行尾序列');
	workingCopy.markDirty();
	assert.deepEqual(statusTexts(statusbar), ['TypeScript', 'LF', 'UTF-8', '行 4，列 9']);
	workingCopy.setExternalChange(true);
	assert.equal(statusTexts(statusbar)[0], '冲突');
});
