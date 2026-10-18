import { emptyEditorGroupsService } from '../../../../test/common/testWorkbenchContextKeys.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { KeybindingTestServices } from '../../../../services/keybinding/test/browser/keybindingTestServices.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IKeyboardLayoutService } from '../../../../../platform/keyboardLayout/common/keyboardLayout.js';
import { IFileTextModelService } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';

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
const { CancellationError } = await import('../../../../../base/common/errors.js');
const { resetNlsResolver, setNlsMessages } = await import('../../../../../nls.js');
const { productLanguagePackCatalogs } = await import('../../../../services/localization/common/localizationCatalogs.js');
const { OperatingSystem } = await import('../../../../../base/common/platform.js');
const { CommandsRegistry, ICommandService } = await import('../../../../../platform/commands/common/commands.js');
const { ContextKeyService } = await import('../../../../../platform/contextkey/browser/contextKeyService.js');
const { ContextKeyExpr } = await import('../../../../../platform/contextkey/common/contextkey.js');
const { ResolvedKeybindingItem } = await import('../../../../../platform/keybinding/common/resolvedKeybindingItem.js');
const { InstantiationService } = await import('../../../../../platform/instantiation/common/instantiationService.js');
const { IConfigurationService } = await import('../../../../../platform/configuration/common/configuration.js');
const { InMemoryConfigurationService } = await import('../../../../../platform/configuration/common/inMemoryConfigurationService.js');
const { IKeybindingService } = await import('../../../../../platform/keybinding/common/keybinding.js');
const { NotificationService } = await import('../../../../../workbench/services/notification/common/notificationService.js');
const { KeybindingsRegistry } = await import('../../../../../platform/keybinding/common/keybindingsRegistry.js');
const { EditorPart } = await import('../../../../../workbench/browser/parts/editor/editorPart.js');
const { EditorPaneMatch, EditorPane } = await import('../../../../../workbench/browser/parts/editor/editorPane.js');
const { EditorPaneRegistry } = await import('../../../../browser/editor.js');
const { EditorInput } = await import('../../../../common/editor/editorInput.js');
const { emptyEditorServiceState } = await import('../../../../test/common/testEditorService.js');
const { KeybindingsEditor } = await import('../../../../../workbench/contrib/preferences/browser/keybindingsEditor.js');
const { CommandService } = await import('../../../../../workbench/services/commands/common/commandService.js');
const { BrowserEditorService } = await import('../../../../../workbench/services/editor/browser/browserEditorService.js');
const { BrowserKeyboardLayoutService } = await import('../../../../../workbench/services/keybinding/browser/keyboardLayoutService.js');
const { WorkbenchKeybindingService } = await import('../../../../../workbench/services/keybinding/browser/keybindingService.js');
const { IKeybindingEditingService } = await import('../../../../services/keybinding/common/keybindingEditing.js');
const { KeybindingsEditorInput, isKeybindingsEditorInput } = await import('../../../../../workbench/services/preferences/browser/keybindingsEditorInput.js');
const { PreferencesService } = await import('../../../../../workbench/services/preferences/browser/preferencesService.js');
const { EditorInputSerializers } = await import('../../../../services/editor/common/editorInputSerializer.js');
const { isSettingsEditorInput } = await import('../../../../../workbench/services/preferences/common/settingsEditorInput.js');
await import('../../browser/preferencesActions.js');

suiteTeardown(() => browserEnvironment.window.close());

test('search action commands and tooltips follow live user bindings without an Escape clear bypass', async () => {
	using disposables = new DisposableStore();
	const { editor, root, resources, keybindings } = await createRecorderFixture(disposables);
	const commands = resources.services.get(ICommandService);
	const search = root.querySelector<HTMLInputElement>('.ash-keybindings-search input')!;
	const [record, sort, clear] = [...root.querySelectorAll<HTMLButtonElement>('.ash-keybindings-search-action')];
	const recordCommand = 'keybindings.editor.recordSearchKeys';
	const sortCommand = 'keybindings.editor.toggleSortByPrecedence';
	const clearCommand = 'keybindings.editor.clearSearchResults';
	editor.search('beta');
	await commands.executeCommand(recordCommand);
	assert.equal(record.getAttribute('aria-pressed'), 'true');
	press(search, 'Escape', 'Escape');
	assert.equal(search.value, 'beta');
	await commands.executeCommand(sortCommand);
	assert.equal(sort.getAttribute('aria-pressed'), 'true');
	await resources.write([
		{ key: 'f6', command: recordCommand, when: 'inKeybindings && inKeybindingsSearch' },
		{ key: 'f7', command: sortCommand, when: 'inKeybindings' },
		{ key: 'f8', command: clearCommand, when: 'inKeybindings && inKeybindingsSearch && keybindingsSearchHasValue' },
		{ key: 'escape', command: null },
	]);
	await keybindings.initialize();
	assert.equal(record.title, 'Record Keys (F6)');
	assert.equal(sort.title, 'Sort by Precedence (Highest first) (F7)');
	assert.equal(clear.title, 'Clear Keybindings Search Input (F8)');
	assert.equal(record.getAttribute('aria-label'), record.title);
	press(search, 'F6', 'F6');
	assert.equal(record.getAttribute('aria-pressed'), 'true');
	press(search, 'Escape', 'Escape');
	assert.equal(record.getAttribute('aria-pressed'), 'false');
	press(search, 'Escape', 'Escape');
	assert.equal(search.value, 'beta', 'A user blocker must suppress the default clear shortcut');
	press(search, 'F7', 'F7');
	assert.equal(sort.getAttribute('aria-pressed'), 'false');
	press(search, 'F8', 'F8');
	assert.equal(search.value, '');
	assert.equal(clear.disabled, true);
	editor.setVisible(false);
	press(search, 'F7', 'F7');
	assert.equal(sort.getAttribute('aria-pressed'), 'false', 'Hidden panes must not own shortcut context');
});

test('search recording matches complete chords, exits on Escape and releases its scoped dispatch guard', async () => {
	using disposables = new DisposableStore();
	const { editor, root, resources } = await createRecorderFixture(disposables);
	const search = root.querySelector<HTMLInputElement>('.ash-keybindings-search input')!;
	const buttons = root.querySelectorAll<HTMLButtonElement>('.ash-keybindings-search-action');
	const record = buttons[0]!;
	const clear = buttons[2]!;
	const readSource = async () => (await resources.files.readFile(resources.profiles.currentProfile.keybindingsResource)).content;
	const original = await readSource();
	record.click();
	assert.equal(record.getAttribute('aria-pressed'), 'true');
	assert.equal(search.readOnly, true);
	assert.equal(search.ownerDocument.activeElement, search);
	const context = resources.services.get(IContextKeyService).getContext(search);
	assert.equal(context.getValue('keybinding.isRecording'), true);
	press(search, 'Digit2', '2', { ctrlKey: true });
	assert.ok(shortcutRow(search.ownerDocument, 'test.shortcuts.beta'));
	assert.equal(root.querySelectorAll('.ash-keybindings-row').length, 1);
	press(search, 'Digit1', '1', { ctrlKey: true });
	assert.equal(root.querySelectorAll('.ash-keybindings-row').length, 0, 'A partial or different sequence must not match a single chord');
	clear.click();
	assert.equal(record.getAttribute('aria-pressed'), 'true');
	for (const digit of ['1', '2', '3', '4']) press(search, `Digit${digit}`, digit, { ctrlKey: true });
	assert.ok(shortcutRow(search.ownerDocument, 'test.shortcuts.alpha'));
	assert.equal(root.querySelectorAll('.ash-keybindings-row').length, 1);
	const fullQuery = search.value;
	press(search, 'Digit4', '4', { ctrlKey: true, repeat: true });
	assert.equal(search.value, fullQuery);
	assert.equal(press(search, 'Tab', 'Tab').defaultPrevented, false);
	editor.setVisible(false);
	assert.equal(context.getValue('keybinding.isRecording'), false);
	editor.setVisible(true);
	assert.equal(context.getValue('keybinding.isRecording'), true);
	press(search, 'Escape', 'Escape');
	assert.equal(search.value, fullQuery);
	assert.equal(search.readOnly, false);
	assert.equal(context.getValue('keybinding.isRecording'), false);
	press(search, 'Escape', 'Escape');
	assert.equal(search.value, '');
	assert.equal(await readSource(), original, 'Search recording never edits keybindings');
	record.click();
	editor.clearInput();
	assert.equal(context.getValue('keybinding.isRecording'), false);
});

test('precedence sorting follows user overrides, explicit rule priority and registration order through live updates', async () => {
	using disposables = new DisposableStore();
	const { editor, root, resources, keybindings } = await createRecorderFixture(disposables);
	const { KeybindingSource } = await import('../../../../../platform/keybinding/common/keybindingsRegistry.js');
	for (const [name, priority, source] of [
		['ZuluEarly', 30, KeybindingSource.Workbench],
		['AlphaLate', 10, KeybindingSource.Workbench],
		['YankeeLatest', 30, KeybindingSource.Workbench],
		['Builtin', 1000, KeybindingSource.Builtin],
	] as const) {
		const command = `test.precedence.${name}`;
		disposables.add(CommandsRegistry.register(command, () => undefined));
		disposables.add(KeybindingsRegistry.registerKeybindingRule({ command, priority, source, keybinding: Keybinding.single(logicalKey('9', { ctrlKey: true, altKey: true })) }));
	}
	editor.search('test.precedence');
	const commands = () => [...root.querySelectorAll('.ash-keybindings-command-id')].map(element => element.textContent);
	const alphabetical = commands();
	const sort = root.querySelectorAll<HTMLButtonElement>('.ash-keybindings-search-action')[1]!;
	sort.click();
	assert.deepEqual(commands(), ['test.precedence.YankeeLatest', 'test.precedence.ZuluEarly', 'test.precedence.AlphaLate', 'test.precedence.Builtin']);
	assert.match(root.querySelector('.ash-keybindings-count')!.textContent!, /precedence/);
	const reloaded = new Promise<void>(resolve => disposables.add(keybindings.onDidUpdateKeybindings(() => resolve())));
	await resources.write([
		{ key: 'ctrl+alt+9', command: 'test.precedence.ZuluEarly' },
		{ key: 'ctrl+alt+9', command: 'test.precedence.AlphaLate' },
	]);
	await reloaded;
	assert.deepEqual(commands().slice(0, 2), ['test.precedence.AlphaLate', 'test.precedence.ZuluEarly']);
	editor.search('"control+option+9" @source:user');
	assert.deepEqual(commands(), ['test.precedence.AlphaLate', 'test.precedence.ZuluEarly']);
	sort.click();
	assert.deepEqual(commands(), ['test.precedence.AlphaLate', 'test.precedence.ZuluEarly']);
	editor.search('test.precedence @source:system');
	assert.deepEqual(commands(), alphabetical);
});

test('Keyboard Shortcuts reuses one modal and reconciles resource rows across editor groups', async () => {
	using disposables = new DisposableStore();
	const ownerDocument = browserEnvironment.window.document;
	ownerDocument.body.replaceChildren();
	let conflictingCommandExecutions = 0;
	disposables.add(CommandsRegistry.register('test.shortcuts.alpha', () => undefined));
	disposables.add(CommandsRegistry.register('workbench.action.chat.attachScreenshot', () => undefined));
	disposables.add(CommandsRegistry.register('workbench.action.chat.attachScreenshot.other', () => undefined));
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
	services.registerInstance(ICommandService, commands);
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
		id: KeybindingsEditor.ID,
		name: 'Keyboard Shortcuts',
		canOpen: input => isKeybindingsEditorInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None,
		create: () => registerTestComponentServices(services).createInstance(KeybindingsEditor),
	});
	const editorServices = disposables.add(createTestEditorServices(undefined, services));
	const editor = disposables.add(editorServices.createInstance(EditorPart, ownerDocument.body, {
		registry,
		contextKeyService: contextKeys,
		keybindingService: keybindings,
		keyboardLayoutService: keyboardLayout,
	}));
	const editorService = new BrowserEditorService(editor);
	const preferences = disposables.add(new PreferencesService(editorService, editorServices.get(IFileTextModelService), resources.files, resources.profiles, editorServices, editorServices.get(IConfigurationService), editorServices.get(IWorkspaceContextService), editorService));
	await preferences.openSettings();
	const modalHost = ownerDocument.querySelector<HTMLElement>('.ash-modal-editor-host');
	assert.ok(modalHost);
	assert.equal(modalHost.hidden, false);

	await preferences.openGlobalKeybindingSettings(false, { query: '@command:workbench.action.chat.attachScreenshot' });
	assert.equal(editorService.activeEditorPane, editor.activePane);
	layoutShortcutTable(editor.activePane as InstanceType<typeof KeybindingsEditor>);
	assert.equal(ownerDocument.querySelectorAll('.ash-keybindings-row').length, 1);
	assert.ok(shortcutRow(ownerDocument, 'workbench.action.chat.attachScreenshot'));
	assert.equal(ownerDocument.activeElement, ownerDocument.querySelector('.ash-keybindings-search input'));
	assert.ok(editor.activeInput instanceof KeybindingsEditorInput);
	const openedInput = editor.activeInput;
	const openedModel = await openedInput.resolve();
	const openedPane = editor.activePane;
	await preferences.openGlobalKeybindingSettings(false, { query: '@command:test.shortcuts.beta' });
	assert.equal(ownerDocument.querySelectorAll('.ash-keybindings-row').length, 1);
	assert.ok(shortcutRow(ownerDocument, 'test.shortcuts.beta'));
	assert.ok(editor.activeInput instanceof EditorInput, 'The shortcut input owns the resolved model lifetime');
	assert.ok(editor.activeInput === openedInput, 'Duplicate opens retain the live input identity');
	assert.ok(await openedInput.resolve() === openedModel, 'Duplicate opens retain the resolved model');
	assert.ok(editor.activePane === openedPane, 'The repeated modal open reuses its pane without rebinding');
	assert.equal(openedInput.isDisposed, false, 'Releasing the duplicate open request retains the pane-owned input');
	assert.equal(modalHost.hidden, false);
	assert.equal(editor.activeGroup.inputs.length, 0);
	assert.equal(editor.activeInput?.resource.toString(), 'ash-preferences:/keyboard-shortcuts');
	assert.equal(ownerDocument.querySelector('.ash-modal-editor-title')?.textContent, 'Keyboard Shortcuts');

	const search = ownerDocument.querySelector<HTMLInputElement>('.ash-keybindings-search input');
	assert.ok(search);
	search.value = 'test.shortcuts';
	search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	const betaBefore = shortcutRow(ownerDocument, 'test.shortcuts.beta');
	assert.ok(betaBefore);
	assert.deepEqual([...betaBefore.querySelectorAll('kbd')].map(key => key.textContent), ['Ctrl', '2']);

	await resources.write([
		{ key: 'ctrl+3', command: 'test.shortcuts.alpha' },
		{ key: 'ctrl+2', command: 'test.shortcuts.beta' },
	]);
	await keybindings.initialize();
	assert.equal(shortcutRow(ownerDocument, 'test.shortcuts.beta'), betaBefore);

	const alpha = shortcutRow(ownerDocument, 'test.shortcuts.alpha');
	assert.ok(alpha);
	assert.deepEqual([...alpha.querySelectorAll('kbd')].map(key => key.textContent), ['Ctrl', '3']);
	findButton(alpha, 'Edit').click();
	const recorder = ownerDocument.querySelector<HTMLInputElement>('.ash-keybindings-record-input input');
	assert.ok(recorder);
	for (const shiftKey of [false, true]) {
		press(recorder, 'Tab', 'Tab', { shiftKey });
		assert.equal(ownerDocument.activeElement, recorder, 'Nested recorder retains focus within the real modal editor host');
	}
	recorder.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', {
		bubbles: true,
		cancelable: true,
		code: 'KeyP',
		key: 'p',
		ctrlKey: true,
		shiftKey: true,
	}));
	assert.equal(conflictingCommandExecutions, 0);
	assert.equal(recorder.value, 'ctrl+shift+p');
	recorder.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', {
		bubbles: true,
		cancelable: true,
		code: 'KeyK',
		key: 'k',
		ctrlKey: true,
	}));
	assert.equal(recorder.value, 'ctrl+shift+p ctrl+k');
	const editorRoot = ownerDocument.querySelector<HTMLElement>('.ash-keybindings-editor');
	assert.ok(editorRoot);
	press(recorder, 'Enter', 'Enter');
	await waitForStatus(ownerDocument, 'Keybinding saved.');
	assert.equal((await resources.read())[0]?.key, 'ctrl+shift+[KeyP] ctrl+[KeyK]');

	await keybindings.initialize();
	const beta = shortcutRow(ownerDocument, 'test.shortcuts.beta');
	assert.ok(beta);
	findButton(beta, 'Remove').click();
	await waitForStatus(ownerDocument, 'Keybinding removed.');
	assert.deepEqual((await resources.read()).map(binding => binding.command), ['test.shortcuts.alpha']);
	let modelDisposals = 0;
	disposables.add(openedModel.onWillDispose(() => { modelDisposals += 1; }));
	// Normal groups can share the same input independently of Preferences' modal target.
	const transfer = openedInput.acquire();
	try {
		await editorService.openEditor(openedInput, { pinned: true }, 'activeGroup');
		layoutShortcutTable(editor.activePane as InstanceType<typeof KeybindingsEditor>);
	} finally {
		transfer.dispose();
	}
	const sourceGroup = editor.activeGroup;
	await editor.splitActiveGroupHorizontal();
	const splitGroup = editor.activeGroup;
	layoutShortcutTable(splitGroup.activePane as InstanceType<typeof KeybindingsEditor>);
	assert.ok(splitGroup !== sourceGroup);
	assert.ok(sourceGroup.inputs[0] === openedInput && splitGroup.inputs[0] === openedInput, 'Both real group records retain the live input passed to the split');
	assert.ok(await (splitGroup.inputs[0] as InstanceType<typeof KeybindingsEditorInput>).resolve() === openedModel);
	const splitSearches = new Map([...ownerDocument.querySelectorAll<HTMLInputElement>('.ash-keybindings-search input')].map(input => [input, input.value]));
	await preferences.openGlobalKeybindingSettings(false, { query: '@command:test.shortcuts.beta' });
	assert.equal(splitSearches.size, 2);
	for (const [input, previousValue] of splitSearches) {
		assert.equal(input.value, previousValue);
	}
	assert.equal((ownerDocument.activeElement as HTMLInputElement).value, '@command:test.shortcuts.beta');
	await preferences.openGlobalKeybindingSettings(false, { query: '' });
	assert.equal(await editor.closeEditor(openedInput), true);
	assert.equal(await sourceGroup.closeEditor(sourceGroup.inputs[0]!), true);
	assert.deepEqual([openedInput.isDisposed, openedModel.isDisposed(), modelDisposals], [false, false, 0]);
	await preferences.openGlobalKeybindingSettings(false);
	assert.ok(splitGroup.inputs[0] === openedInput, 'A duplicate open in the remaining group keeps its live metadata');
	assert.equal(await editor.closeEditor(openedInput), true);
	const remainingRoot = ownerDocument.querySelector<HTMLElement>('.ash-keybindings-editor');
	assert.ok(remainingRoot);
	findButton(shortcutRow(ownerDocument, 'test.shortcuts.alpha')!, 'Edit').click();
	press(remainingRoot.querySelector<HTMLInputElement>('.ash-keybindings-record-input input')!, 'KeyJ', 'j', { ctrlKey: true });
	press(remainingRoot.querySelector<HTMLInputElement>('.ash-keybindings-record-input input')!, 'Enter', 'Enter');
	await waitForStatus(ownerDocument, 'Keybinding saved.');
	assert.equal((await resources.read())[0]?.key, 'ctrl+[KeyJ]');
	// Closing the source's last tab retires that empty group. Create a live target
	// for the move while retaining the same input and resolved shortcut model.
	const targetGroup = editor.addGroup(splitGroup.id, 'left');
	await splitGroup.moveEditorTo(splitGroup.inputs[0]!, targetGroup, 0);
	editor.activateGroup(targetGroup.id);
	assert.equal(splitGroup.inputs.length, 0);
	assert.ok(targetGroup.inputs[0] === openedInput, 'Moving the recorded tab input opens the target before the source releases it');
	assert.ok(await (targetGroup.inputs[0] as InstanceType<typeof KeybindingsEditorInput>).resolve() === openedModel);
	assert.deepEqual([openedInput.isDisposed, openedModel.isDisposed(), modelDisposals], [false, false, 0]);
	const serializedInput = EditorInputSerializers.serialize(openedInput);
	assert.equal(await editor.closeEditor(openedInput), true);
	assert.deepEqual([openedInput.isDisposed, openedModel.isDisposed(), modelDisposals], [true, true, 1]);

	const restoredResource = EditorInputSerializers.deserialize(serializedInput);
	await editorService.openEditor(restoredResource, { pinned: true });
	const restoredInput = KeybindingsEditorInput.getOrCreate(restoredResource, editorServices);
	const restoredModel = await restoredInput.resolve();
	await preferences.openGlobalKeybindingSettings(false);
	assert.ok(editor.activeInput === restoredInput, 'Opening restored shortcuts retains the pane input');
	assert.ok(await restoredInput.resolve() === restoredModel, 'Restored shortcuts retain one model');
	assert.equal(editor.activeGroup.inputs.length, 1);
	assert.equal(await editor.closeEditor(restoredInput), true);
	assert.deepEqual([restoredInput.isDisposed, restoredModel.isDisposed()], [false, false]);
	assert.equal(await editor.closeEditor(restoredInput), true);
	assert.deepEqual([restoredInput.isDisposed, restoredModel.isDisposed()], [true, true]);
});

test('shared shortcut input keeps one model until the last pane releases it', async () => {
	using disposables = new DisposableStore();
	const { document, root, resources, keybindings, editor, editorInput } = await createRecorderFixture(disposables);
	const model = await editorInput.resolve();
	const search = root.querySelector<HTMLInputElement>('.ash-keybindings-search input')!;
	search.value = 'test.shortcuts.alpha';
	search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	const secondPane = disposables.add(registerTestComponentServices(resources.services).createInstance(KeybindingsEditor));
	const secondHost = h(document, 'div');
	document.body.append(secondHost);
	secondPane.create(secondHost);
	layoutShortcutTable(secondPane);
	await secondPane.setInput(editorInput, new AbortController().signal);
	await editor.setInput(editorInput, new AbortController().signal);
	assert.ok(await editorInput.resolve() === model, 'Shared panes resolve the same model');
	assert.equal(root.querySelectorAll('.ash-keybindings-row').length, 1);
	assert.ok(secondHost.querySelectorAll('.ash-keybindings-row').length > 1, 'Split panes keep independent search fields');
	let disposed = 0;
	let updates = 0;
	disposables.add(model.onWillDispose(() => { disposed += 1; }));
	disposables.add(model.onDidChange(() => { updates += 1; }));
	await resources.write([{ key: 'ctrl+9', command: 'test.shortcuts.alpha' }, { key: 'ctrl+2', command: 'test.shortcuts.beta' }]);
	await keybindings.initialize();
	assert.equal(root.querySelectorAll('.ash-keybindings-row').length, 1);
	assert.ok(secondHost.querySelectorAll('.ash-keybindings-row').length > 1);
	editor.clearInput();
	assert.equal(model.isDisposed(), false);
	await resources.write([{ key: 'ctrl+8', command: 'test.shortcuts.alpha' }, { key: 'ctrl+2', command: 'test.shortcuts.beta' }]);
	await keybindings.initialize();
	assert.ok(updates > 0);
	secondPane.dispose();
	assert.deepEqual([editorInput.isDisposed, model.isDisposed(), disposed], [true, true, 1]);
	const previousUpdates = updates;
	await resources.write([{ key: 'ctrl+7', command: 'test.shortcuts.alpha' }, { key: 'ctrl+2', command: 'test.shortcuts.beta' }]);
	await keybindings.initialize();
	assert.equal(updates, previousUpdates, 'A closed input releases model service listeners');
});

test('restored shortcut resource inputs rehydrate and release the input-owned model', async () => {
	using disposables = new DisposableStore();
	const { document, resources, keybindings, editor, editorInput } = await createRecorderFixture(disposables);
	const previousModel = await editorInput.resolve();
	await editor.setInput({ resource: editorInput.resource, contentType: editorInput.contentType }, new AbortController().signal);
	assert.equal(previousModel.isDisposed(), true);
	await resources.write([{ key: 'ctrl+9', command: 'test.shortcuts.alpha' }]);
	await keybindings.initialize();
	assert.deepEqual([...shortcutRow(document, 'test.shortcuts.alpha')!.querySelectorAll('kbd')].map(key => key.textContent), ['Ctrl', '9']);
	editor.clearInput();
	assert.equal(document.querySelectorAll('.ash-keybindings-row').length, 0);
});

test('disposed shortcut inputs and frozen restored resources replace retired cached inputs', async () => {
	using disposables = new DisposableStore();
	const { resources, editor, editorInput } = await createRecorderFixture(disposables);
	const restoredResource = EditorInputSerializers.deserialize(EditorInputSerializers.serialize(editorInput));
	assert.equal(Object.isFrozen(restoredResource), true);
	editor.clearInput();
	assert.equal(editorInput.isDisposed, true);
	assert.throws(() => editorInput.acquire(), ReferenceError);
	await assert.rejects(editorInput.resolve(), ReferenceError);
	for (const resource of [editorInput, restoredResource]) {
		const first = KeybindingsEditorInput.getOrCreate(resource, resources.services);
		using firstReference = first.acquire();
		const model = await first.resolve();
		assert.ok(first !== resource, 'A retired or plain input rehydrates a new class instance');
		assert.ok(KeybindingsEditorInput.getOrCreate(resource, resources.services) === first, 'The weak cache reuses the live rehydrated input');
		firstReference.dispose();
		firstReference.dispose();
		assert.deepEqual([first.isDisposed, model.isDisposed()], [true, true]);
		const replacement = KeybindingsEditorInput.getOrCreate(resource, resources.services);
		using replacementReference = replacement.acquire();
		const replacementModel = await replacement.resolve();
		assert.ok(replacement !== first && replacementModel !== model, 'A disposed weak-cache value is replaced together with its model');
		assert.ok(KeybindingsEditorInput.getOrCreate(resource, resources.services) === replacement);
		replacementReference.dispose();
		assert.deepEqual([replacement.isDisposed, replacementModel.isDisposed()], [true, true]);
	}
});

test('cancelled shortcut resolution releases the acquired model and leaves no rows', async () => {
	using disposables = new DisposableStore();
	const { document, resources, editor } = await createRecorderFixture(disposables);
	const input = resources.services.createInstance(KeybindingsEditorInput);
	const model = await input.resolve();
	const gate = new DeferredPromise<void>();
	input.resolve = async () => { await gate.p; return model; };
	const controller = new AbortController();
	const opening = editor.setInput(input, controller.signal);
	controller.abort();
	await gate.complete();
	await assert.rejects(opening, /cancelled/);
	assert.deepEqual([input.isDisposed, model.isDisposed(), document.querySelectorAll('.ash-keybindings-row').length], [true, true, 0]);
});

for (const cancelled of [false, true]) {
	test(`${cancelled ? 'cancelled' : 'failed'} shortcut open requests release resolved models and replace the retired service cache on retry`, async () => {
		using disposables = new DisposableStore();
		const { resources } = await createRecorderFixture(disposables);
		const openedInputs: InstanceType<typeof KeybindingsEditorInput>[] = [];
		let disposed = 0;
		const failure = cancelled ? new CancellationError('Test editor open cancelled') : new Error('Test editor open failed');
		const preferences = disposables.add(new PreferencesService({
			...emptyEditorServiceState,
			openEditor: async input => {
				assert.ok(input instanceof KeybindingsEditorInput);
				openedInputs.push(input);
				const model = await input.resolve();
				disposables.add(model.onWillDispose(() => { disposed += 1; }));
				throw failure;
			},
			focusActiveEditor() { },
		}, resources.models, resources.files, resources.profiles, resources.services, disposables.add(new InMemoryConfigurationService()), disposables.add(createTestEditorServices()).get(IWorkspaceContextService), emptyEditorGroupsService));
		await assert.rejects(preferences.openGlobalKeybindingSettings(false), error => error === failure);
		assert.deepEqual([openedInputs[0]?.isDisposed, disposed], [true, 1]);
		await assert.rejects(preferences.openGlobalKeybindingSettings(false), error => error === failure);
		assert.ok(openedInputs[1] !== openedInputs[0], 'A retry does not reuse the disposed service cache value');
		assert.deepEqual([openedInputs.length, openedInputs[1]?.isDisposed, disposed], [2, true, 2]);
	});
}

test('failed shortcut pane resolution releases its input lease and resolved model', async () => {
	using disposables = new DisposableStore();
	const { document, resources, editor } = await createRecorderFixture(disposables);
	const input = resources.services.createInstance(KeybindingsEditorInput);
	const model = await input.resolve();
	const failure = new Error('Test shortcut resolve failed');
	input.resolve = async () => { throw failure; };
	await assert.rejects(editor.setInput(input, new AbortController().signal), error => error === failure);
	assert.deepEqual([input.isDisposed, model.isDisposed(), document.querySelectorAll('.ash-keybindings-row').length], [true, true, 0]);
});

test('retired shortcut resolution cannot clear a replacement using the same input', async () => {
	using disposables = new DisposableStore();
	const { root, resources, editor } = await createRecorderFixture(disposables);
	const input = resources.services.createInstance(KeybindingsEditorInput);
	const model = await input.resolve();
	const gate = new DeferredPromise<void>();
	let resolutions = 0;
	input.resolve = async () => {
		if (resolutions++ === 0) await gate.p;
		return model;
	};
	const previous = new AbortController();
	const opening = editor.setInput(input, previous.signal);
	await editor.setInput(input, new AbortController().signal);
	previous.abort();
	await gate.complete();
	await assert.rejects(opening, /cancelled/);
	assert.equal(model.isDisposed(), false, 'The replacement pane reference still owns the model');
	assert.ok(root.querySelector('.ash-keybindings-row'));
	editor.clearInput();
	assert.deepEqual([input.isDisposed, model.isDisposed()], [true, true]);
});

test('recorder opens an empty modal, previews keys, ignores incomplete input and explicitly restarts after four chords', async () => {
	using disposables = new DisposableStore();
	const { document, input, root, open, resources } = await createRecorderFixture(disposables);
	open();
	assert.equal(input.value, '');
	const dialog = root.querySelector('[role="dialog"]')!;
	assert.equal(dialog.getAttribute('aria-modal'), 'true');
	assert.match(dialog.getAttribute('aria-label')!, /Alpha/);
	assert.equal(document.activeElement, input);
	assert.equal(root.querySelectorAll('.ash-keybindings-recorder input').length, 1);
	assert.equal(root.querySelectorAll('.ash-keybindings-recorder button').length, 0);
	assert.equal(root.querySelector<HTMLElement>('.ash-keybindings-list')?.inert, true);
	press(input, 'AltLeft', 'Alt', { altKey: true });
	press(input, 'MetaLeft', 'Meta', { altKey: true, metaKey: true });
	assert.equal(input.value, 'alt+win');
	assert.deepEqual([...root.querySelectorAll('.ash-keybindings-recorder-preview kbd')].map(key => key.textContent), ['Alt', 'Windows']);
	press(input, 'Enter', 'Enter');
	assert.equal(root.querySelector<HTMLElement>('.ash-keybindings-recorder')?.hidden, false, 'Modifiers alone cannot be saved');
	const help = document.getElementById(input.getAttribute('aria-describedby')!);
	assert.match(help?.textContent ?? '', /up to 4 chords/);
	assert.match(help?.textContent ?? '', /Use Keyboard Shortcuts \(JSON\) for bare Enter, Escape, Tab or Shift\+Tab/);
	press(input, 'KeyK', 'k', { ctrlKey: true });
	assert.equal(input.value, 'ctrl+k');
	for (const options of [
		{ code: 'KeyK', key: 'k', ctrlKey: true, repeat: true },
		{ code: 'ShiftLeft', key: 'Shift', shiftKey: true },
		{ code: 'KeyP', key: 'p', isComposing: true },
		{ code: 'KeyP', key: 'Process' },
	]) input.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options }));
	assert.equal(input.value, 'ctrl+k');
	press(input, 'KeyP', 'p', { ctrlKey: true });
	press(input, 'KeyC', 'c', { altKey: true });
	press(input, 'KeyD', 'd', { ctrlKey: true, shiftKey: true });
	assert.equal(input.value, 'ctrl+k ctrl+p alt+c ctrl+shift+d');
	press(input, 'KeyY', 'y', { ctrlKey: true });
	assert.equal(input.value, 'ctrl+y');
	assert.equal(root.querySelector('[role="status"]')?.textContent, 'Started a new sequence after 4 chords: ctrl+[KeyY].');
	press(input, 'Escape', 'Escape');
	press(input, 'Escape', 'Escape');
	assert.equal(root.querySelector<HTMLElement>('.ash-keybindings-list')?.inert, false);
	assert.equal(document.activeElement, shortcutRow(document, 'test.shortcuts.alpha')?.querySelector('button'));
	assert.equal((await resources.read())[0]?.key, 'ctrl+1 ctrl+2 ctrl+3 ctrl+4');
});

test('recorder reserves bare controls, records modified Enter and Escape, and saves all four chords', async () => {
	using disposables = new DisposableStore();
	const { document, input, root, open, resources, keybindings } = await createRecorderFixture(disposables);
	open();
	for (const shiftKey of [false, true]) {
		const event = press(input, 'Tab', 'Tab', { shiftKey });
		assert.equal(event.defaultPrevented, true);
	}
	assert.equal(input.value, '');
	press(input, 'KeyK', 'k', { ctrlKey: true });
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
	assert.equal(input.value, 'ctrl+k shift+enter alt+escape ctrl+enter');
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
	const { document, input, root, open, resources } = await createRecorderFixture(disposables);
	const resource = resources.profiles.currentProfile.keybindingsResource;
	using reference = await resources.models.acquire({ resource, languageId: 'jsonc' }, new AbortController().signal);
	reference.model.pushEditOperations(null, [{ range: reference.model.getFullModelRange(), text: '// unsaved\n' + reference.model.getValue() }], null);
	open();
	press(input, 'KeyK', 'k', { ctrlKey: true });
	press(input, 'KeyP', 'p', { ctrlKey: true });
	const failed = waitForStatus(document, 'Save keybindings.json before changing a shortcut in the Keyboard Shortcuts editor.');
	press(input, 'Enter', 'Enter');
	await failed;
	assert.equal(input.value, 'ctrl+k ctrl+p');
	assert.equal(document.activeElement, input);
	assert.equal(input.disabled, false);
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
	press(input, 'Enter', 'Enter');
	await enteredSave;
	try {
		assert.equal(input.disabled, true);
		assert.equal(root.querySelector('.ash-keybindings-recorder')?.getAttribute('aria-busy'), 'true');
		assert.ok([...root.querySelectorAll<HTMLButtonElement>('.ash-keybindings-row button')].every(button => button.disabled));
		press(input, 'KeyY', 'y', { ctrlKey: true });
		press(input, 'Escape', 'Escape');
		assert.equal(input.value, 'ctrl+k ctrl+p');
		press(input, 'Escape', 'Escape');
		findButton(shortcutRow(document, 'test.shortcuts.beta')!, 'Edit').click();
		assert.match(root.querySelector('[role="dialog"]')?.getAttribute('aria-label') ?? '', /Alpha/);
		assert.equal((await resources.read())[0]?.key, 'ctrl+1 ctrl+2 ctrl+3 ctrl+4');
	} finally { release(); }
	await saved;
	assert.deepEqual((await resources.read())[0], { key: 'ctrl+[KeyK] ctrl+[KeyP]', command: 'test.shortcuts.alpha', args: { retained: true } });
	assert.match((await resources.files.readFile(resource)).content, /keep recorder comment/);
	assert.equal(root.querySelector('.ash-keybindings-recorder')?.getAttribute('aria-busy'), 'false');
	assert.equal(input.disabled, false);
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
			press(input, 'Enter', 'Enter');
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
				await editor.setInput(resources.services.createInstance(KeybindingsEditorInput), new AbortController().signal);
				open();
				assert.equal(input.disabled, false, 'A live pane can record again after the retired save completes');
			}
			assert.equal((await resources.read())[0]?.key, outcome === 'resolve' ? 'ctrl+[KeyK] ctrl+[KeyP]' : 'ctrl+1 ctrl+2 ctrl+3 ctrl+4');
		});
	}
}

test('recorder help and restart announcements use the Chinese catalog', async () => {
	using disposables = new DisposableStore();
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages('zh-CN', chinese.bundles);
	disposables.add(toDisposable(resetNlsResolver));
	const { document, input, root, open } = await createRecorderFixture(disposables);
	open();
	assert.equal(root.getAttribute('aria-label'), '键盘快捷方式');
	const alpha = shortcutRow(document, 'test.shortcuts.alpha')!;
	assert.equal(alpha.querySelector('.ash-keybindings-source')?.textContent, '用户');
	assert.match(alpha.querySelector('.ash-keybindings-row-action')?.getAttribute('aria-label') ?? '', /编辑/);
	const help = document.getElementById(input.getAttribute('aria-describedby')!);
	assert.match(help?.textContent ?? '', /最多 4 段组合键/);
	assert.match(help?.textContent ?? '', /键盘快捷方式（JSON）中编辑/);
	for (const letter of ['K', 'P', 'C', 'D', 'Y']) press(input, `Key${letter}`, letter.toLowerCase(), { ctrlKey: true });
	assert.equal(root.querySelector('[role="status"]')?.textContent, '已录满 4 段，开始新序列：ctrl+[KeyY]。');
	press(input, 'Escape', 'Escape');
	assert.equal(root.querySelector('[role="status"]')?.textContent, '快捷键已清空。请录制新序列，或再次按 Escape 取消。');
});

test('source menu filters system, user, extension and unassigned rows and edits a system condition intact', async () => {
	using disposables = new DisposableStore();
	const { document, editor, resources, keybindings } = await createRecorderFixture(disposables);
	let jsonRequests = 0;
	resources.services.registerInstance(IPreferencesService, {
		openGlobalKeybindingSettings: async textual => { assert.equal(textual, true); jsonRequests += 1; },
	} as IPreferencesService);
	await editor.getActions()[0].run();
	assert.equal(jsonRequests, 1);
	const when = ContextKeyExpr.or(ContextKeyExpr.equals('editorMode', 'edit'), ContextKeyExpr.not('readOnly'))!;
	disposables.add(CommandsRegistry.register('test.shortcuts.system', () => undefined));
	disposables.add(CommandsRegistry.register('test.shortcuts.unassigned', () => undefined));
	disposables.add(KeybindingsRegistry.registerKeybindingRule({
		command: 'test.shortcuts.system', keybinding: Keybinding.single(logicalKey('s', { ctrlKey: true })), when,
	}));
	const getBindings = keybindings.getKeybindings.bind(keybindings);
	keybindings.getKeybindings = () => [...getBindings(), new ResolvedKeybindingItem(
		keybindings.resolveKeybinding(Keybinding.single(logicalKey('e', { ctrlKey: true }))),
		'test.shortcuts.extension', undefined, when, true, 'test.extension', false,
	)];
	await editor.setInput(resources.services.createInstance(KeybindingsEditorInput), new AbortController().signal);
	for (const [source, command, id] of [
		['system', 'system', 'keybindings.editor.showDefaultKeybindings'],
		['user', 'alpha', 'keybindings.editor.showUserKeybindings'],
		['extension', 'extension', 'keybindings.editor.showExtensionKeybindings'],
		['unassigned', 'unassigned', 'keybindings.editor.showUnassignedKeybindings'],
	] as const) {
		await editor.getSecondaryActions().find(action => action.id === id)!.run();
		assert.equal(document.querySelector<HTMLInputElement>('.ash-keybindings-search input')?.value, `@source:${source}`);
		editor.search(`@source:${source} @command:test.shortcuts.${command}`);
		assert.ok(shortcutRow(document, `test.shortcuts.${command}`));
		const visibleRows = document.querySelectorAll('.ash-keybindings-row');
		assert.ok(visibleRows.length > 0);
		assert.equal(editor.getSecondaryActions().find(action => action.id === id)?.checked, true);
		if (source === 'extension') assert.equal(visibleRows.length, 1);
		if (source !== 'user') assert.equal(shortcutRow(document, 'test.shortcuts.alpha'), undefined);
	}
	editor.search('@source:default @command:test.shortcuts.system');
	const row = shortcutRow(document, 'test.shortcuts.system')!;
	assert.equal(document.querySelectorAll('.ash-keybindings-row').length, 1);
	assert.ok(row.querySelector('.ash-keybindings-row-action svg'));
	findButton(row, 'Edit').click();
	const input = document.querySelector<HTMLInputElement>('.ash-keybindings-record-input input')!;
	assert.equal(input.value, '');
	press(input, 'KeyJ', 'j', { ctrlKey: true });
	const saved = waitForStatus(document, 'Keybinding saved.');
	press(input, 'Enter', 'Enter');
	await saved;
	assert.equal((await resources.read()).find(binding => binding.command === 'test.shortcuts.system')?.when, when.serialize());
	editor.search('@source:unassigned @command:test.shortcuts.unassigned');
	findButton(shortcutRow(document, 'test.shortcuts.unassigned')!, 'Add').click();
	assert.equal(input.value, '');
	await editor.getSecondaryActions().find(action => action.id === 'keybindings.editor.clearSearchResults')!.run();
	assert.ok(shortcutRow(document, 'test.shortcuts.alpha'));
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
	resources.services.registerInstance(ICommandService, commands);
	const layout = disposables.add(new BrowserKeyboardLayoutService({ navigator: browserEnvironment.window.navigator, operatingSystem: OperatingSystem.Windows }));
	const keybindings = disposables.add(new WorkbenchKeybindingService({ ownerDocument: document, commandService: commands, contextKeyService: contextKeys, keyboardLayoutService: layout }, disposables.add(new NotificationService()), resources.files, resources.profiles));
	resources.services.registerInstance(IKeybindingService, keybindings);
	resources.services.registerInstance(IContextKeyService, contextKeys);
	resources.services.registerInstance(IKeyboardLayoutService, layout);
	await keybindings.initialize();
	const editor = disposables.add(registerTestComponentServices(resources.services).createInstance(KeybindingsEditor));
	editor.create(document.body);
	resources.services.registerInstance(IEditorService, {
		...emptyEditorServiceState,
		activeEditorPane: editor,
		openEditor: async () => undefined,
		focusActiveEditor: () => editor.focus(),
	});
	layoutShortcutTable(editor);
	const editorInput = resources.services.createInstance(KeybindingsEditorInput);
	await editor.setInput(editorInput, new AbortController().signal);
	const root = document.querySelector<HTMLElement>('.ash-keybindings-editor')!;
	const input = root.querySelector<HTMLInputElement>('.ash-keybindings-record-input input')!;
	return {
		document, input, root, resources, keybindings, editor, editorInput, open: () => {
			const button = shortcutRow(document, 'test.shortcuts.alpha')!.querySelector<HTMLButtonElement>('.ash-keybindings-row-action')!;
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

/** jsdom supplies no viewport geometry; the real Table still owns layout and virtualization. */
function layoutShortcutTable(editor: InstanceType<typeof KeybindingsEditor>): void {
	const container = editor.getContainer()!.querySelector<HTMLElement>('.ash-keybindings-list')!;
	Object.defineProperties(container, {
		clientWidth: { configurable: true, value: 1000 },
		clientHeight: { configurable: true, value: 600 },
	});
	const viewport = container.querySelector<HTMLElement>('.ash-scrollbar-viewport')!;
	Object.defineProperties(viewport, {
		clientWidth: { configurable: true, value: 1000 },
		clientHeight: { configurable: true, value: 570 },
		scrollHeight: { configurable: true, get: () => Number.parseFloat(viewport.querySelector<HTMLElement>('.ash-list')?.style.height ?? '0') || 0 },
	});
	editor.layout({ width: 1000, height: 600 });
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
