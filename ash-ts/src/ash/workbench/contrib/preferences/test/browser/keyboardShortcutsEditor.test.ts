import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';

const browserEnvironment = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
Object.defineProperty(browserEnvironment.window.Element.prototype, 'scrollTo', { configurable: true, value() {} });
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
const { Disposable, DisposableStore } = await import('../../../../../base/common/lifecycle.js');
const { OperatingSystem } = await import('../../../../../base/common/platform.js');
const { CommandsRegistry } = await import('../../../../../platform/commands/common/commands.js');
const { ContextKeyService } = await import('../../../../../platform/contextkey/browser/contextKeyService.js');
const { ServiceContainer } = await import('../../../../../platform/instantiation/common/instantiation.js');
const { KeybindingsRegistry } = await import('../../../../../platform/keybinding/common/keybindingsRegistry.js');
const { EditorPart } = await import('../../../../../workbench/browser/parts/editor/editorPart.js');
const { EditorPaneMatch } = await import('../../../../../workbench/browser/parts/editor/editorPane.js');
const { EditorPaneRegistry } = await import('../../../../../workbench/browser/parts/editor/editorRegistry.js');
const { KeyboardShortcutsEditor, KeyboardShortcutsEditorId } = await import('../../../../../workbench/contrib/preferences/browser/keyboardShortcutsEditor.js');
const { CommandService } = await import('../../../../../workbench/services/commands/common/commandService.js');
const { BrowserEditorService } = await import('../../../../../workbench/services/editor/browser/browserEditorService.js');
const { BrowserKeyboardLayoutService } = await import('../../../../../workbench/services/keybinding/browser/keyboardLayoutService.js');
const { WorkbenchKeybindingService } = await import('../../../../../workbench/services/keybinding/browser/keybindingService.js');
const { KeybindingsResourceContribution } = await import('../../../../../workbench/services/keybinding/browser/keybindingsResourceContribution.js');
const { WorkbenchKeybindingsResourceService } = await import('../../../../../workbench/services/keybinding/browser/keybindingsResourceService.js');
const { createKeyboardShortcutsEditorInput, isKeyboardShortcutsEditorInput } = await import('../../../../../workbench/services/preferences/browser/keybindingsEditorInput.js');
const { PreferencesService } = await import('../../../../../workbench/services/preferences/browser/preferencesService.js');
const { isPreferencesEditorInput } = await import('../../../../../workbench/services/preferences/common/preferencesEditorInput.js');

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

	const resources = disposables.add(new WorkbenchKeybindingsResourceService());
	await resources.updateKeybindings([
		{ key: 'ctrl+1', command: 'test.shortcuts.alpha' },
		{ key: 'ctrl+2', command: 'test.shortcuts.beta' },
	]);
	disposables.add(new KeybindingsResourceContribution({ service: resources }));
	const contextKeys = disposables.add(new ContextKeyService());
	const commands = disposables.add(new CommandService(new ServiceContainer()));
	const keyboardLayout = disposables.add(new BrowserKeyboardLayoutService({
		navigator: browserEnvironment.window.navigator,
		operatingSystem: OperatingSystem.Windows,
	}));
	const keybindings = disposables.add(new WorkbenchKeybindingService({
		ownerDocument,
		commandService: commands,
		contextKeyService: contextKeys,
		keyboardLayoutService: keyboardLayout,
	}));
	const registry = new EditorPaneRegistry();
	registry.register({
		id: 'test.preferences',
		name: 'Preferences',
		canOpen: input => isPreferencesEditorInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None,
		create: () => new TestPreferencesEditor(),
	});
	registry.register({
		id: KeyboardShortcutsEditorId,
		name: 'Keyboard Shortcuts',
		canOpen: input => isKeyboardShortcutsEditorInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None,
		create: () => new KeyboardShortcutsEditor({
			contextKeyService: contextKeys,
			keybindingService: keybindings,
			keybindingsResourceService: resources,
			keyboardLayoutService: keyboardLayout,
		}),
	});
	const editor = disposables.add(new EditorPart(ownerDocument.body, {
		registry,
		contextKeyService: contextKeys,
		keybindingService: keybindings,
		keybindingsResourceService: resources,
		keyboardLayoutService: keyboardLayout,
	}));
	const editorService = new BrowserEditorService(editor);
	const preferences = disposables.add(new PreferencesService(() => editorService));
	await preferences.openSettings();
	const modalHost = ownerDocument.querySelector<HTMLElement>('.ash-modal-editor-host');
	assert.ok(modalHost);
	assert.equal(modalHost.hidden, false);

	await preferences.openKeybindings();
	await preferences.openKeybindings();
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

	await resources.updateKeybindings([
		{ key: 'ctrl+3', command: 'test.shortcuts.alpha' },
		{ key: 'ctrl+2', command: 'test.shortcuts.beta' },
	]);
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
	const editorRoot = ownerDocument.querySelector<HTMLElement>('.ash-keybindings-editor');
	assert.ok(editorRoot);
	findButton(editorRoot, 'Save').click();
	await nextTurn();
	assert.equal(resources.getKeybindings()[0]?.key, 'ctrl+shift+[KeyP]');

	const beta = shortcutRow(ownerDocument, 'test.shortcuts.beta');
	assert.ok(beta);
	findButton(beta, 'Remove').click();
	await nextTurn();
	assert.deepEqual(resources.getKeybindings().map(binding => binding.command), ['test.shortcuts.alpha']);
});

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

function nextTurn(): Promise<void> {
	return new Promise(resolve => globalThis.setTimeout(resolve, 0));
}

class TestPreferencesEditor extends Disposable {
	readonly id = 'test.preferences';
	private element: HTMLElement | undefined;

	create(parent: HTMLElement): void {
		this.element = h(parent.ownerDocument, 'div');
		this.element.tabIndex = -1;
		parent.append(this.element);
	}

	async setInput(): Promise<void> {}
	clearInput(): void {}
	layout(): void {}
	setVisible(): void {}
	focus(): void { this.element?.focus(); }
}
