import { KeybindingTestServices } from '../../../../services/keybinding/test/browser/keybindingTestServices.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IKeyboardLayoutService } from '../../../../../platform/keyboardLayout/common/keyboardLayout.js';
import { IFileTextModelService } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';

import { createTestEditorServices, registerTestComponentServices } from '../../../../test/common/testEditorServices.js';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';

const browserEnvironment = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
Object.defineProperty(browserEnvironment.window.Element.prototype, 'scrollTo', { configurable: true, value() { } });
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	MouseEvent: browserEnvironment.window.MouseEvent,
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
	navigator: browserEnvironment.window.navigator,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { Keybinding, logicalKey } = await import('../../../../../base/common/keybindings.js');
const { h } = await import('../../../../../base/browser/dom.js');
const { DisposableStore, toDisposable } = await import('../../../../../base/common/lifecycle.js');
const { DeferredPromise } = await import('../../../../../base/common/async.js');
const { resetNlsResolver, setNlsMessages } = await import('../../../../../nls.js');
const { builtinLanguagePackCatalogs } = await import('../../../../services/localization/common/localizationCatalogs.js');
const { OperatingSystem } = await import('../../../../../base/common/platform.js');
const { CommandsRegistry } = await import('../../../../../platform/commands/common/commands.js');
const { ContextKeyService } = await import('../../../../../platform/contextkey/browser/contextKeyService.js');
const { InstantiationService } = await import('../../../../../platform/instantiation/common/instantiationService.js');
const { IConfigurationService } = await import('../../../../../platform/configuration/common/configuration.js');
const { InMemoryConfigurationService } = await import('../../../../../platform/configuration/common/inMemoryConfigurationService.js');
const { IKeybindingService } = await import('../../../../../platform/keybinding/common/keybinding.js');
const { NotificationService } = await import('../../../../../workbench/services/notification/common/notificationService.js');
const { KeybindingsRegistry } = await import('../../../../../platform/keybinding/common/keybindingsRegistry.js');
const { EditorPart } = await import('../../../../../workbench/browser/parts/editor/editorPart.js');
const { EditorPaneMatch, EditorPane } = await import('../../../../../workbench/browser/parts/editor/editorPane.js');
const { EditorPaneRegistry } = await import('../../../../browser/editor.js');
const { KeyboardShortcutsEditor, KeyboardShortcutsEditorId } = await import('../../../../../workbench/contrib/preferences/browser/keyboardShortcutsEditor.js');
const { CommandService } = await import('../../../../../workbench/services/commands/common/commandService.js');
const { BrowserEditorService } = await import('../../../../../workbench/services/editor/browser/browserEditorService.js');
const { BrowserKeyboardLayoutService } = await import('../../../../../workbench/services/keybinding/browser/keyboardLayoutService.js');
const { WorkbenchKeybindingService } = await import('../../../../../workbench/services/keybinding/browser/keybindingService.js');
const { IKeybindingEditingService } = await import('../../../../services/keybinding/common/keybindingEditing.js');
const { createKeyboardShortcutsEditorInput, isKeyboardShortcutsEditorInput } = await import('../../../../../workbench/services/preferences/browser/keybindingsEditorInput.js');
const { PreferencesService } = await import('../../../../../workbench/services/preferences/browser/preferencesService.js');
const { isSettingsEditorInput } = await import('../../../../../workbench/services/preferences/common/settingsEditorInput.js');

suiteTeardown(() => browserEnvironment.window.close());

test('Keyboard Shortcuts opens as one Editor tab and reconciles resource rows incrementally', async () => {
	using disposables = new DisposableStore();
	const ownerDocument = browserEnvironment.window.document;
	ownerDocument.body.replaceChildren();
	let conflictingCommandExecutions = 0;
	disposables.add(CommandsRegistry.register('test.shortcuts.alpha', () => undefined));
	disposables.add(CommandsRegistry.register('test.shortcuts.beta', () => undefined));
	disposables.add(CommandsRegistry.register('test.shortcuts.conflict', () => { conflictingCommandExecutions += 1; }));
	disposables.add(KeybindingsRegistry.registerKeybindingRule({
		command: 'test.shortcuts.conflict',
		keybinding: Keybinding.single(logicalKey('p', { ctrlKey: true, shiftKey: true })),
	}));

	const resources = disposables.add(new KeybindingTestServices());
	await resources.write([
		{ key: 'ctrl+1', command: 'test.shortcuts.alpha' },
		{ key: 'ctrl+2', command: 'test.shortcuts.beta' },
	]);
	const services = resources.services;
	const contextKeys = disposables.add(new ContextKeyService());
	const commands = disposables.add(new CommandService(new InstantiationService()));
	const keyboardLayout = disposables.add(new BrowserKeyboardLayoutService({
		navigator: browserEnvironment.window.navigator,
		operatingSystem: OperatingSystem.Windows,
	}));
	const keybindings = disposables.add(new WorkbenchKeybindingService({
		ownerDocument,
		commandService: commands,
		contextKeyService: contextKeys,
		keyboardLayoutService: keyboardLayout,
	}, disposables.add(new NotificationService()), resources.files, resources.profiles));
	const configuration = disposables.add(new InMemoryConfigurationService());
	services.registerInstance(IKeybindingService, keybindings);
	services.registerInstance(IContextKeyService, contextKeys);
	services.registerInstance(IKeyboardLayoutService, keyboardLayout);
	await keybindings.initialize();
	services.registerInstance(IConfigurationService, configuration);
	const registry = new EditorPaneRegistry();
	registry.registerEditorPane({
		id: 'test.settings',
		name: 'Settings',
		canOpen: input => isSettingsEditorInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None,
		create: () => registerTestComponentServices(services).createInstance(TestSettingsEditor),
	});
	registry.registerEditorPane({
		id: KeyboardShortcutsEditorId,
		name: 'Keyboard Shortcuts',
		canOpen: input => isKeyboardShortcutsEditorInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None,
		create: () => registerTestComponentServices(services).createInstance(KeyboardShortcutsEditor),
	});
	const editorServices = disposables.add(createTestEditorServices(undefined, services));
	const editor = disposables.add(editorServices.createInstance(EditorPart, ownerDocument.body, {
		registry,
		contextKeyService: contextKeys,
		keybindingService: keybindings,
		keyboardLayoutService: keyboardLayout,
	}));
	const editorService = new BrowserEditorService(editor);
	const preferences = disposables.add(new PreferencesService(editorService, editorServices.get(IFileTextModelService), resources.files, resources.profiles));
	await preferences.openSettings();
	const modalHost = ownerDocument.querySelector<HTMLElement>('.ash-modal-editor-host');
	assert.ok(modalHost);
	assert.equal(modalHost.hidden, false);

	await preferences.openGlobalKeybindingSettings(false);
	await preferences.openGlobalKeybindingSettings(false);
	assert.equal(modalHost.hidden, true);
	assert.equal(editor.activeGroup.inputs.length, 1);
	assert.equal(editor.activeInput?.resource.toString(), createKeyboardShortcutsEditorInput().resource.toString());
	assert.equal(ownerDocument.querySelector('.ash-tab-label')?.textContent, 'Keyboard Shortcuts');

	const search = ownerDocument.querySelector<HTMLInputElement>('.ash-keybindings-search input');
	assert.ok(search);
	search.value = 'test.shortcuts';
	search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	const betaBefore = shortcutRow(ownerDocument, 'test.shortcuts.beta');
	assert.ok(betaBefore);

	await resources.write([
		{ key: 'ctrl+3', command: 'test.shortcuts.alpha' },
		{ key: 'ctrl+2', command: 'test.shortcuts.beta' },
	]);
	await keybindings.initialize();
	assert.equal(shortcutRow(ownerDocument, 'test.shortcuts.beta'), betaBefore);

	const alpha = shortcutRow(ownerDocument, 'test.shortcuts.alpha');
	assert.ok(alpha);
	findButton(alpha, 'Edit').click();
	const recorder = ownerDocument.querySelector<HTMLInputElement>('.ash-keybindings-record-input input');
	assert.ok(recorder);
	recorder.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', {
		bubbles: true,
		cancelable: true,
		code: 'KeyP',
		key: 'p',
		ctrlKey: true,
		shiftKey: true,
	}));
	assert.equal(conflictingCommandExecutions, 0);
	assert.equal(recorder.value, 'ctrl+shift+[KeyP]');
	recorder.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', {
		bubbles: true,
		cancelable: true,
		code: 'KeyK',
		key: 'k',
		ctrlKey: true,
	}));
	assert.equal(recorder.value, 'ctrl+shift+[KeyP] ctrl+[KeyK]');
	const editorRoot = ownerDocument.querySelector<HTMLElement>('.ash-keybindings-editor');
	assert.ok(editorRoot);
	findButton(editorRoot, 'Save').click();
	await waitForStatus(ownerDocument, 'Keybinding saved.');
	assert.equal((await resources.read())[0]?.key, 'ctrl+shift+[KeyP] ctrl+[KeyK]');

	await keybindings.initialize();
	const beta = shortcutRow(ownerDocument, 'test.shortcuts.beta');
	assert.ok(beta);
	findButton(beta, 'Remove').click();
	await waitForStatus(ownerDocument, 'Keybinding removed.');
	assert.deepEqual((await resources.read()).map(binding => binding.command), ['test.shortcuts.alpha']);
});

test('recorder replaces the preview, ignores incomplete input and explicitly restarts after four chords', async () => {
	using disposables = new DisposableStore();
	const { document, input, root, open, resources } = await createRecorderFixture(disposables);
	open();
	assert.equal(input.value, 'ctrl+1 ctrl+2 ctrl+3 ctrl+4');
	const help = document.getElementById(input.getAttribute('aria-describedby')!);
	assert.match(help?.textContent ?? '', /up to 4 chords/);
	assert.match(help?.textContent ?? '', /Use Keyboard Shortcuts \(JSON\) for bare Enter, Escape, Tab or Shift\+Tab/);
	press(input, 'KeyK', 'k', { ctrlKey: true });
	assert.equal(input.value, 'ctrl+[KeyK]');
	for (const options of [
		{ code: 'KeyK', key: 'k', ctrlKey: true, repeat: true },
		{ code: 'ShiftLeft', key: 'Shift', shiftKey: true },
		{ code: 'KeyP', key: 'p', isComposing: true },
		{ code: 'KeyP', key: 'Process' },
	]) input.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options }));
	assert.equal(input.value, 'ctrl+[KeyK]');
	press(input, 'KeyP', 'p', { ctrlKey: true });
	press(input, 'KeyC', 'c', { altKey: true });
	press(input, 'KeyD', 'd', { ctrlKey: true, shiftKey: true });
	assert.equal(input.value, 'ctrl+[KeyK] ctrl+[KeyP] alt+[KeyC] ctrl+shift+[KeyD]');
	press(input, 'KeyY', 'y', { ctrlKey: true });
	assert.equal(input.value, 'ctrl+[KeyY]');
	assert.equal(root.querySelector('[role="status"]')?.textContent, 'Started a new sequence after 4 chords: ctrl+[KeyY].');
	findButton(root, 'Cancel').click();
	assert.equal(document.activeElement, shortcutRow(document, 'test.shortcuts.alpha')?.querySelector('button'));
	assert.equal((await resources.read())[0]?.key, 'ctrl+1 ctrl+2 ctrl+3 ctrl+4');
});

test('recorder reserves bare controls, records modified Enter and Escape, and saves all four chords', async () => {
	using disposables = new DisposableStore();
	const { document, input, root, open, resources, keybindings } = await createRecorderFixture(disposables);
	open();
	for (const shiftKey of [false, true]) {
		const event = press(input, 'Tab', 'Tab', { shiftKey });
		assert.equal(event.defaultPrevented, false);
	}
	assert.equal(input.value, 'ctrl+1 ctrl+2 ctrl+3 ctrl+4');
	press(input, 'Escape', 'Escape');
	assert.equal(input.value, '');
	assert.equal(root.querySelector<HTMLElement>('.ash-keybindings-recorder')?.hidden, false);
	press(input, 'Escape', 'Escape');
	assert.equal(root.querySelector<HTMLElement>('.ash-keybindings-recorder')?.hidden, true);
	open();
	press(input, 'KeyK', 'k', { ctrlKey: true });
	press(input, 'Enter', 'Enter', { shiftKey: true });
	press(input, 'Escape', 'Escape', { altKey: true });
	press(input, 'Enter', 'Enter', { ctrlKey: true });
	assert.equal(input.value, 'ctrl+[KeyK] shift+[Enter] alt+[Escape] ctrl+[Enter]');
	const saved = waitForStatus(document, 'Keybinding saved.');
	press(input, 'Enter', 'Enter');
	await saved;
	assert.equal((await resources.read())[0]?.key, 'ctrl+[KeyK] shift+[Enter] alt+[Escape] ctrl+[Enter]');
	await keybindings.initialize();
	assert.equal(keybindings.resolveUserBinding((await resources.read())[0]!.key)?.chords.length, 4);
	assert.equal(root.querySelector<HTMLElement>('.ash-keybindings-recorder')?.hidden, true);
});

test('recorder preserves a failed draft, retries through the shared model and locks it while saving', async () => {
	using disposables = new DisposableStore();
	const { document, input, when, root, open, resources } = await createRecorderFixture(disposables);
	const resource = resources.profiles.currentProfile.keybindingsResource;
	using reference = await resources.models.acquire({ resource, languageId: 'jsonc' }, new AbortController().signal);
	reference.model.pushEditOperations(null, [{ range: reference.model.getFullModelRange(), text: '// unsaved\n' + reference.model.getValue() }], null);
	open();
	press(input, 'KeyK', 'k', { ctrlKey: true });
	press(input, 'KeyP', 'p', { ctrlKey: true });
	when.value = 'true';
	when.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	const failed = waitForStatus(document, 'Save keybindings.json before changing a shortcut in the Keyboard Shortcuts editor.');
	findButton(root, 'Save').click();
	await failed;
	assert.equal(input.value, 'ctrl+[KeyK] ctrl+[KeyP]');
	assert.equal(when.value, 'true');
	assert.equal(document.activeElement, input);
	assert.equal(findButton(root, 'Save').disabled, false);
	assert.equal(root.querySelector<HTMLElement>('.ash-keybindings-recorder')?.hidden, false);
	assert.equal((await resources.read())[0]?.key, 'ctrl+1 ctrl+2 ctrl+3 ctrl+4');
	await reference.revert(new AbortController().signal);
	let entered!: () => void;
	let release!: () => void;
	const enteredSave = new Promise<void>(resolve => { entered = resolve; });
	const pendingSave = new Promise<void>(resolve => { release = resolve; });
	disposables.add(resources.models.addSaveParticipant({
		participate: async model => {
			if (model !== reference.model) return;
			entered();
			await pendingSave;
		}
	}));
	const saved = waitForStatus(document, 'Keybinding saved.');
	findButton(root, 'Save').click();
	await enteredSave;
	try {
		assert.equal(input.disabled, true);
		assert.equal(when.disabled, true);
		assert.equal(root.querySelector('.ash-keybindings-recorder')?.getAttribute('aria-busy'), 'true');
		assert.equal(findButton(root, 'Cancel').disabled, true);
		assert.ok([...root.querySelectorAll<HTMLButtonElement>('.ash-keybindings-row button')].every(button => button.disabled));
		press(input, 'KeyY', 'y', { ctrlKey: true });
		press(input, 'Escape', 'Escape');
		assert.equal(input.value, 'ctrl+[KeyK] ctrl+[KeyP]');
		findButton(root, 'Cancel').click();
		findButton(shortcutRow(document, 'test.shortcuts.beta')!, 'Edit').click();
		assert.match(root.querySelector('h2')?.textContent ?? '', /Alpha/);
		assert.equal((await resources.read())[0]?.key, 'ctrl+1 ctrl+2 ctrl+3 ctrl+4');
	} finally { release(); }
	await saved;
	assert.deepEqual((await resources.read())[0], { key: 'ctrl+[KeyK] ctrl+[KeyP]', command: 'test.shortcuts.alpha', args: { retained: true }, when: 'true' });
	assert.match((await resources.files.readFile(resource)).content, /keep recorder comment/);
	assert.equal(root.querySelector('.ash-keybindings-recorder')?.getAttribute('aria-busy'), 'false');
	assert.equal(findButton(root, 'Cancel').disabled, false);
});

for (const retirement of ['clear', 'hide', 'dispose', 'focus another editor'] as const) {
	for (const outcome of ['resolve', 'reject'] as const) {
		test(`pending recorder save ${outcome} after ${retirement} does not update a disposed pane or take another editor's focus`, async () => {
			using disposables = new DisposableStore();
			const { document, input, root, open, resources, editor, keybindings } = await createRecorderFixture(disposables);
			const entered = new DeferredPromise<void>();
			const gate = new DeferredPromise<void>();
			disposables.add(toDisposable(() => { void gate.complete(); }));
			disposables.add(resources.models.addSaveParticipant({
				participate: async () => {
					await entered.complete();
					await gate.p;
				}
			}));
			const editing = resources.services.get(IKeybindingEditingService);
			const edit = editing.editKeybinding.bind(editing);
			let pending: Promise<void> | undefined;
			editing.editKeybinding = (...args) => pending = edit(...args);
			open();
			press(input, 'KeyK', 'k', { ctrlKey: true });
			press(input, 'KeyP', 'p', { ctrlKey: true });
			findButton(root, 'Save').click();
			await entered.p;
			const controls = [...root.querySelectorAll<HTMLElement>('input, button, [role="status"], .ash-keybindings-recorder')];
			if (retirement === 'clear') editor.clearInput();
			if (retirement === 'hide') editor.setVisible(false);
			if (retirement === 'dispose') editor.dispose();
			const otherEditor = h(document, 'input');
			document.body.append(otherEditor);
			otherEditor.focus();
			assert.equal(document.activeElement, otherEditor);
			let focusCalls = 0;
			for (const control of controls.filter(control => control.tagName === 'INPUT')) {
				const focus = control.focus.bind(control);
				control.focus = () => { focusCalls += 1; focus(); };
			}
			const mutations: MutationRecord[] = [];
			const observer = new browserEnvironment.window.MutationObserver(records => mutations.push(...records));
			disposables.add(toDisposable(() => observer.disconnect()));
			for (const control of [root, ...controls]) observer.observe(control, { attributes: true, childList: true, characterData: true, subtree: true });
			const status = root.querySelector('[role="status"]')?.textContent;
			if (outcome === 'resolve') await gate.complete();
			else await gate.error(new Error('Test profile save failed.'));
			await pending?.catch(() => undefined);
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(document.activeElement, otherEditor);
			assert.equal(focusCalls, 0, 'Save completion must leave focus with its current owner');
			if (retirement === 'dispose') assert.equal(mutations.length, 0, 'Disposed pane controls must remain untouched');
			if (retirement === 'clear') {
				assert.equal(root.querySelector('[role="status"]')?.textContent, status, 'A retired draft must not receive late status');
				await keybindings.initialize();
				open();
				assert.equal(input.disabled, false, 'A live pane can record again after the retired save completes');
			}
			assert.equal((await resources.read())[0]?.key, outcome === 'resolve' ? 'ctrl+[KeyK] ctrl+[KeyP]' : 'ctrl+1 ctrl+2 ctrl+3 ctrl+4');
		});
	}
}

test('recorder help and restart announcements use the Chinese catalog', async () => {
	using disposables = new DisposableStore();
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages('zh-CN', chinese.bundles);
	disposables.add(toDisposable(resetNlsResolver));
	const { document, input, root, open } = await createRecorderFixture(disposables);
	open();
	const help = document.getElementById(input.getAttribute('aria-describedby')!);
	assert.match(help?.textContent ?? '', /最多 4 段组合键/);
	assert.match(help?.textContent ?? '', /键盘快捷方式（JSON）中编辑/);
	for (const letter of ['K', 'P', 'C', 'D', 'Y']) press(input, `Key${letter}`, letter.toLowerCase(), { ctrlKey: true });
	assert.equal(root.querySelector('[role="status"]')?.textContent, '已录满 4 段，开始新序列：ctrl+[KeyY]。');
	press(input, 'Escape', 'Escape');
	assert.equal(root.querySelector('[role="status"]')?.textContent, '快捷键已清空。请录制新序列，或再次按 Escape 取消。');
});

/** Keeps every recorder case on the real mapper, editing queue and isolated profile file. */
async function createRecorderFixture(disposables: InstanceType<typeof DisposableStore>) {
	const document = browserEnvironment.window.document;
	document.body.replaceChildren();
	for (const command of ['test.shortcuts.alpha', 'test.shortcuts.beta']) disposables.add(CommandsRegistry.register(command, () => undefined));
	const resources = disposables.add(new KeybindingTestServices());
	await resources.writeSource('// keep recorder comment\n[{"key":"ctrl+1 ctrl+2 ctrl+3 ctrl+4","command":"test.shortcuts.alpha","args":{"retained":true}},{"key":"ctrl+2","command":"test.shortcuts.beta"},]\n');
	const contextKeys = disposables.add(new ContextKeyService());
	const commands = disposables.add(new CommandService(resources.services));
	const layout = disposables.add(new BrowserKeyboardLayoutService({ navigator: browserEnvironment.window.navigator, operatingSystem: OperatingSystem.Windows }));
	const keybindings = disposables.add(new WorkbenchKeybindingService({ ownerDocument: document, commandService: commands, contextKeyService: contextKeys, keyboardLayoutService: layout }, disposables.add(new NotificationService()), resources.files, resources.profiles));
	resources.services.registerInstance(IKeybindingService, keybindings);
	resources.services.registerInstance(IContextKeyService, contextKeys);
	resources.services.registerInstance(IKeyboardLayoutService, layout);
	await keybindings.initialize();
	const editor = disposables.add(registerTestComponentServices(resources.services).createInstance(KeyboardShortcutsEditor));
	editor.create(document.body);
	const root = document.querySelector<HTMLElement>('.ash-keybindings-editor')!;
	const input = root.querySelector<HTMLInputElement>('.ash-keybindings-record-input input')!;
	const when = root.querySelector<HTMLInputElement>('[aria-label="Keybinding when condition"]')!;
	return {
		document, input, when, root, resources, keybindings, editor, open: () => {
			const button = findButton(shortcutRow(document, 'test.shortcuts.alpha')!, 'Edit');
			button.focus();
			button.click();
		}
	};
}

function press(input: HTMLInputElement, code: string, key: string, options: KeyboardEventInit = {}): KeyboardEvent {
	const event = new browserEnvironment.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, code, key, ...options });
	input.dispatchEvent(event);
	return event;
}

function shortcutRow(ownerDocument: Document, command: string): HTMLElement | undefined {
	return [...ownerDocument.querySelectorAll<HTMLElement>('.ash-keybindings-row')]
		.find(row => row.querySelector('.ash-keybindings-command-id')?.textContent === command);
}

function findButton(container: ParentNode, label: string): HTMLButtonElement {
	const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
		.find(candidate => candidate.textContent === label);
	assert.ok(button, `Expected ${label} button`);
	return button;
}

function waitForStatus(document: Document, message: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const observer = new browserEnvironment.window.MutationObserver(() => {
			if (document.querySelector('.ash-keybindings-status')?.textContent !== message) return;
			observer.disconnect();
			clearTimeout(timeout);
			resolve();
		});
		const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`Shortcut editor did not report ${message}: ${document.querySelector('.ash-keybindings-status')?.textContent}`)); }, 5_000);
		observer.observe(document.body, { childList: true, subtree: true, characterData: true });
	});
}

class TestSettingsEditor extends EditorPane {
	readonly id = 'test.settings';
	private element: HTMLElement | undefined;

	constructor(@IThemeService themeService: IThemeService, @IStorageService storageService: IStorageService) {
		super('test.settings', themeService, storageService);
	}

	public override create(parent: HTMLElement): void {
		this.element = h(parent.ownerDocument, 'div');
		this.element.tabIndex = -1;
		parent.append(this.element);
		super.create(this.element);
	}

	public override async setInput(): Promise<void> { }
	public override clearInput(): void { }
	public override layout(): void { }
	public override focus(): void { this.element?.focus(); }
}
