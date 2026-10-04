import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Keybinding, logicalKey, type ResolvedKeybinding } from '../../../../../base/common/keybindings.js';
import { KeyboardDispatchMode } from '../../../../../platform/keyboardLayout/common/keyboardLayout.js';
import { FallbackKeyboardMapper } from '../../../../services/keybinding/common/fallbackKeyboardMapper.js';
import { parseKeybinding } from '../../../../../base/common/keybindingParser.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { installEditorTestDom } from '../../../../../editor/test/browser/editorTestGlobals.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { AccessibilityCommandId } from '../../common/accessibilityCommands.js';
import { resolveContentAndKeybindingItems } from '../../browser/accessibleViewKeybindingResolver.js';
import '../../browser/accessibilityConfiguration.js';
import '../../browser/accessibleViewActions.js';
import { AccessibleViewService } from '../../browser/accessibleView.js';
import { AccessibilityService } from '../../../../../platform/accessibility/browser/accessibilityService.js';
import { IAccessibilityService, AccessibilitySupport } from '../../../../../platform/accessibility/common/accessibility.js';
import { IStatusbarService, StatusbarService, StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { NotificationService } from '../../../../services/notification/common/notificationService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { AccessibilityStatus } from '../../browser/accessibilityStatus.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { StandaloneCodeEditorService } from '../../../../../editor/standalone/browser/standaloneCodeEditorService.js';
import type { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { EditorAccessibilityHelpContribution } from '../../browser/editorAccessibilityHelp.js';
import { INotificationsCenter } from '../../../../browser/parts/notifications/notificationsCenter.js';
import { AccessibilityWorkbenchSettingId } from '../../browser/accessibilityConfiguration.js';
import '../../../../browser/parts/notifications/notificationAccessibleView.js';
import '../../../codeEditor/browser/accessibility/accessibility.js';

test('Explorer accessibility hint follows the verbosity setting', async () => {
	using fixture = new AccessibleViewFixture();
	const { configuration, accessibleView } = fixture;
	assert.match(accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.Explorer) ?? '', /Alt\+F1/);
	await configuration.updateValue(AccessibilityVerbositySettingId.Explorer, false);
	assert.equal(accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.Explorer), undefined);
	await configuration.updateValue(AccessibilityVerbositySettingId.Explorer, true);
	assert.match(accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.Explorer) ?? '', /Alt\+F1/);
	assert.match(accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.OpenEditors) ?? '', /Alt\+F1/);
	await configuration.updateValue(AccessibilityVerbositySettingId.OpenEditors, false);
	assert.equal(accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.OpenEditors), undefined);
	assert.match(accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.DiffEditor) ?? '', /Alt\+F1/);
	await configuration.updateValue(AccessibilityVerbositySettingId.DiffEditor, false);
	assert.equal(accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.DiffEditor), undefined);
	assert.match(accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.ChatModelConfiguration) ?? '', /Alt\+F1/);
	await configuration.updateValue(AccessibilityVerbositySettingId.ChatModelConfiguration, false);
	assert.equal(accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.ChatModelConfiguration), undefined);
});

test('help resolves repeated and unassigned shortcuts using the current keyboard layout', () => {
	using fixture = new AccessibleViewFixture();
	const result = resolveContentAndKeybindingItems(fixture.keybindings, 'Open <keybinding:editor.action.accessibilityHelp> twice <keybinding:editor.action.accessibilityHelp> and <keybinding:test.missing>.');
	assert.deepEqual({
		text: result?.content.value,
		assigned: result?.configuredKeybindingItems,
		unassigned: result?.configureKeybindingItems,
		trusted: result?.content.isTrusted,
	}, {
		text: 'Open Alt+F1 twice Alt+F1 and No keyboard shortcut assigned for test.missing.',
		assigned: [{ id: AccessibilityCommandId.OpenAccessibilityHelp, label: AccessibilityCommandId.OpenAccessibilityHelp }],
		unassigned: [{ id: 'test.missing', label: 'test.missing' }],
		trusted: false,
	});
	assert.equal(resolveContentAndKeybindingItems(fixture.keybindings, ''), undefined);
});

test('hint follows reassignment and removal of the help shortcut in Chinese', () => {
	using fixture = new AccessibleViewFixture();
	initializeTestLocalization('zh-CN');
	try {
		fixture.helpKeybinding = fixture.keybindings.resolveKeybinding(Keybinding.single(logicalKey('F1', { ctrlKey: true, shiftKey: true })));
		assert.equal(fixture.accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.Explorer), '按 Ctrl+Shift+F1 打开无障碍帮助。');
		fixture.helpKeybinding = undefined;
		assert.equal(fixture.accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.Explorer), '在命令面板中运行“打开无障碍帮助”。');
	} finally {
		resetNlsResolver();
	}
});

test('opening help publishes its state, disables only the active hint and releases provider listeners on close', async () => {
	using fixture = new AccessibleViewFixture();
	let reads = 0;
	let closed = 0;
	using changed = new Emitter<void>();
	using registration = AccessibleViewRegistry.register({
		type: AccessibleViewType.Help,
		name: 'test.accessibility.lifecycle',
		priority: 1000,
		getProvider: () => {
			const provider = new AccessibleContentProvider(AccessibleViewProviderId.Explorer, { type: AccessibleViewType.Help }, () => {
				reads++;
				return '<keybinding:editor.action.accessibilityHelp>';
			}, () => { closed++; }, AccessibilityVerbositySettingId.Explorer);
			provider.onDidChangeContent = changed.event;
			return provider;
		},
	});
	await fixture.commands.executeCommand(AccessibilityCommandId.OpenAccessibilityHelp);
	const text = fixture.browser.window.document.querySelector('textarea')!;
	assert.equal(text.value, 'Alt+F1');
	assert.equal(fixture.contextKeys.getValue('accessibilityHelpIsShown'), true);
	fixture.helpKeybinding = fixture.keybindings.resolveKeybinding(Keybinding.single(logicalKey('F1', { ctrlKey: true })));
	fixture.keybindingChanges.fire();
	assert.equal(text.value, 'Control+F1');
	changed.fire();
	assert.equal(reads, 3);
	await fixture.commands.executeCommand(AccessibilityCommandId.DisableVerbosityHint);
	assert.equal(fixture.configuration.getValue(AccessibilityVerbositySettingId.Explorer), false);
	assert.equal(fixture.configuration.getValue(AccessibilityVerbositySettingId.OpenEditors), true);
	assert.equal(fixture.contextKeys.getValue('accessibleViewVerbosityEnabled'), false);
	assert.equal(fixture.accessibleView.show(AccessibleViewType.Help), false);
	fixture.browser.window.document.querySelector('dialog')!.close();
	await Promise.resolve();
	assert.equal(closed, 1);
	assert.equal(fixture.contextKeys.getValue('accessibilityHelpIsShown'), false);
	assert.equal(fixture.browser.window.document.querySelector('dialog'), null);
	changed.fire();
	fixture.keybindingChanges.fire();
	assert.equal(reads, 3);
});

test('a failed dialog open releases the provider and resets command state', () => {
	using fixture = new AccessibleViewFixture();
	let closed = 0;
	using registration = AccessibleViewRegistry.register({
		type: AccessibleViewType.View,
		name: 'test.accessibility.failedOpen',
		priority: 1000,
		getProvider: () => new AccessibleContentProvider(AccessibleViewProviderId.Explorer, { type: AccessibleViewType.View }, () => 'content', () => { closed++; }, AccessibilityVerbositySettingId.Explorer),
	});
	fixture.browser.window.HTMLDialogElement.prototype.showModal = () => { throw new Error('Cannot show modal'); };
	assert.throws(() => fixture.accessibleView.show(AccessibleViewType.View), /Cannot show modal/u);
	assert.equal(closed, 1);
	assert.equal(fixture.contextKeys.getValue('accessibleViewIsShown'), false);
	assert.equal(fixture.browser.window.document.querySelector('dialog'), null);
});

test('screen reader commands update policy, status and notification choices through window services', async () => {
	using fixture = new AccessibleViewFixture();
	using contribution = fixture.services.createInstance(AccessibilityStatus);
	assert.deepEqual(fixture.statusbar.getEntries(StatusbarAlignment.Right), []);
	await fixture.commands.executeCommand('editor.action.toggleScreenReaderAccessibilityMode');
	const entry = fixture.statusbar.getEntries(StatusbarAlignment.Right)[0]!;
	assert.equal(fixture.accessibility.isScreenReaderOptimized(), true);
	assert.equal(entry.id, 'status.editor.screenReaderMode');
	await entry.entry.run!();
	const notification = fixture.notifications.getNotifications()[0]!;
	await notification.actions!.find(action => action.id === 'accessibility.screenReader.off')!.run();
	assert.deepEqual({ optimized: fixture.accessibility.isScreenReaderOptimized(), entries: fixture.statusbar.getEntries(StatusbarAlignment.Right), notifications: fixture.notifications.getNotifications() }, {
		optimized: false,
		entries: [],
		notifications: [],
	});
});

test('automatic detection prompts once and releases the prompt and status when the window closes', () => {
	using fixture = new AccessibleViewFixture();
	const contribution = fixture.services.createInstance(AccessibilityStatus);
	try {
		fixture.accessibility.setAccessibilitySupport(AccessibilitySupport.Enabled);
		assert.equal(fixture.notifications.getNotifications().length, 1);
		fixture.accessibility.setAccessibilitySupport(AccessibilitySupport.Disabled);
		fixture.accessibility.setAccessibilitySupport(AccessibilitySupport.Enabled);
		assert.equal(fixture.notifications.getNotifications().length, 0);
		contribution.dispose();
		assert.deepEqual(fixture.statusbar.getEntries(StatusbarAlignment.Right), []);
		fixture.accessibility.setAccessibilitySupport(AccessibilitySupport.Disabled);
		fixture.accessibility.setAccessibilitySupport(AccessibilitySupport.Enabled);
		assert.deepEqual(fixture.statusbar.getEntries(StatusbarAlignment.Right), []);
	} finally {
		contribution.dispose();
	}
});

test('editor help reads the editor state and its focus hint respects verbosity and editor removal', async () => {
	using fixture = new AccessibleViewFixture();
	using focused = new Emitter<void>();
	let readOnly = true;
	let restored = 0;
	const editor = {
		getId: () => 'test.editor',
		isSimpleWidget: false,
		hasTextFocus: () => true,
		hasWidgetFocus: () => false,
		onDidFocusEditorText: focused.event,
		onDidFocusEditorWidget: Event.None,
		getOption: (option: EditorOption) => option === EditorOption.readOnly ? readOnly : option === EditorOption.tabFocusMode,
		focus: () => { restored++; },
	} as unknown as ICodeEditor;
	fixture.codeEditors.addCodeEditor(editor);
	using contribution = fixture.services.createInstance(EditorAccessibilityHelpContribution);
	fixture.contextKeys.setContext('editorTextFocus', true);
	const messages: string[] = [];
	fixture.accessibility.status = message => messages.push(message);
	await fixture.commands.executeCommand('editor.action.toggleScreenReaderAccessibilityMode');
	focused.fire();
	assert.deepEqual(messages, ['Press Alt+F1 for accessibility help.']);
	await fixture.commands.executeCommand(AccessibilityCommandId.OpenAccessibilityHelp);
	const text = fixture.browser.window.document.querySelector('textarea')!;
	assert.match(text.value, /read-only text editor[\s\S]*optimization is enabled[\s\S]*Tab moves focus/u);
	fixture.browser.window.document.querySelector('dialog')!.close();
	await Promise.resolve();
	assert.equal(restored, 1);
	readOnly = false;
	await fixture.commands.executeCommand(AccessibilityCommandId.OpenAccessibilityHelp);
	assert.match(fixture.browser.window.document.querySelector('textarea')!.value, /editable text editor/u);
	await fixture.commands.executeCommand(AccessibilityCommandId.DisableVerbosityHint);
	focused.fire();
	assert.equal(messages.length, 1);
	fixture.codeEditors.removeCodeEditor(editor);
	focused.fire();
	assert.equal(messages.length, 1);
});

test('notification content remains live through nested help and the reading position survives updates', async () => {
	using fixture = new AccessibleViewFixture();
	let returned = 0;
	fixture.services.registerInstance(INotificationsCenter, { show: () => { returned++; } } as INotificationsCenter);
	fixture.contextKeys.setContext('notificationsFocus', true);
	fixture.notifications.info('First notification');
	await fixture.commands.executeCommand(AccessibilityCommandId.OpenAccessibleView);
	const view = fixture.browser.window.document.querySelector('textarea')!;
	view.setSelectionRange(2, 5);
	fixture.notifications.info('Second notification');
	assert.match(view.value, /First notification[\s\S]*Second notification/u);
	assert.deepEqual([view.selectionStart, view.selectionEnd], [2, 5]);
	await fixture.commands.executeCommand(AccessibilityCommandId.OpenAccessibilityHelp);
	assert.equal(fixture.browser.window.document.querySelectorAll('dialog').length, 2);
	assert.equal(fixture.contextKeys.getValue('accessibilityHelpIsShown'), true);
	fixture.notifications.clear();
	assert.equal(view.value, 'No notifications');
	fixture.browser.window.document.querySelectorAll('dialog')[1]!.close();
	await Promise.resolve();
	assert.equal(fixture.contextKeys.getValue('accessibleViewIsShown'), true);
	assert.equal(returned, 0);
	fixture.browser.window.document.querySelector('dialog')!.close();
	await Promise.resolve();
	assert.equal(returned, 1);
	assert.equal(fixture.contextKeys.getValue('accessibleViewIsShown'), false);
});

test('dimming configuration validates the supported opacity range at the settings boundary', async () => {
	using fixture = new AccessibleViewFixture();
	await assert.rejects(fixture.configuration.updateValue(AccessibilityWorkbenchSettingId.DimUnfocusedOpacity, 0.1), /between 0.2 and 1/u);
	assert.equal(fixture.configuration.getValue(AccessibilityWorkbenchSettingId.DimUnfocusedOpacity), 0.75);
	await fixture.configuration.updateValue(AccessibilityWorkbenchSettingId.DimUnfocusedOpacity, 0.4);
	assert.equal(fixture.configuration.getValue(AccessibilityWorkbenchSettingId.DimUnfocusedOpacity), 0.4);
});

test('closing the parent content view releases nested help and its keybinding listener', async () => {
	using fixture = new AccessibleViewFixture();
	let returned = 0;
	fixture.services.registerInstance(INotificationsCenter, { show: () => { returned++; } } as INotificationsCenter);
	fixture.contextKeys.createKey<boolean>('notificationsFocus', false).set(true);
	fixture.notifications.info('Keep reading');
	await fixture.commands.executeCommand(AccessibilityCommandId.OpenAccessibleView);
	await fixture.commands.executeCommand(AccessibilityCommandId.OpenAccessibilityHelp);
	const dialogs = fixture.browser.window.document.querySelectorAll('dialog');
	const help = dialogs[1]!.querySelector('textarea')!;
	assert.match(help.value, /Control\+Alt\+H/u);
	help.setSelectionRange(2, 5);
	fixture.disableHintKeybinding = fixture.keybindings.resolveKeybinding(Keybinding.single(logicalKey('h', { ctrlKey: true, shiftKey: true })));
	fixture.keybindingChanges.fire();
	assert.match(help.value, /Control\+Shift\+H/u);
	assert.deepEqual([help.selectionStart, help.selectionEnd], [2, 5]);
	dialogs[0]!.close();
	await Promise.resolve();
	assert.equal(fixture.browser.window.document.querySelectorAll('dialog').length, 0);
	assert.equal(returned, 1);
	assert.equal(fixture.contextKeys.getValue('accessibilityHelpIsShown'), false);
	assert.equal(fixture.contextKeys.getValue('accessibleViewIsShown'), false);
	assert.equal(fixture.contextKeys.getValue('accessibleViewCurrentProviderId'), '');
	const closedContent = help.value;
	fixture.disableHintKeybinding = undefined;
	fixture.keybindingChanges.fire();
	assert.equal(help.value, closedContent);
});

class AccessibleViewFixture extends Disposable {
	public readonly browser = new JSDOM('<!doctype html><body></body>');
	public readonly configuration = this._register(new InMemoryConfigurationService());
	public readonly contextKeys = this._register(new ContextKeyService());
	public readonly services = this._register(new InstantiationService());
	public readonly keybindingChanges = this._register(new Emitter<void>());
	public readonly codeEditors = this._register(new StandaloneCodeEditorService());
	public readonly statusbar = this._register(new StatusbarService());
	public readonly notifications = this._register(new NotificationService());
	public readonly accessibility: AccessibilityService;
	private readonly mapper = new FallbackKeyboardMapper({ dispatch: KeyboardDispatchMode.Code, mapAltGrToCtrlAlt: false }, OperatingSystem.Windows);
	public helpKeybinding: ResolvedKeybinding | undefined = this.mapper.resolveKeybinding(Keybinding.single(logicalKey('F1', { altKey: true })))[0];
	public disableHintKeybinding: ResolvedKeybinding | undefined = this.mapper.resolveKeybinding(Keybinding.single(logicalKey('h', { ctrlKey: true, altKey: true })))[0];
	public readonly keybindings: IKeybindingService = {
		inChordMode: false,
		onDidUpdateKeybindings: this.keybindingChanges.event,
		resolveKeybinding: binding => this.mapper.resolveKeybinding(binding)[0]!,
		resolveUserBinding: binding => {
			const parsed = parseKeybinding(binding);
			return parsed ? this.mapper.resolveKeybinding(parsed)[0] : undefined;
		},
		lookupKeybinding: command => {
			if (command === AccessibilityCommandId.DisableVerbosityHint) {
				return this.disableHintKeybinding;
			}
			if (command !== AccessibilityCommandId.OpenAccessibilityHelp || !this.helpKeybinding) {
				return undefined;
			}
			return this.helpKeybinding;
		},
		lookupKeybindings: command => {
			const binding = this.keybindings.lookupKeybinding(command);
			return binding ? [binding] : [];
		},
	};
	public readonly accessibleView: AccessibleViewService;
	public readonly commands: CommandService;

	constructor() {
		super();
		this._register(toDisposable(() => this.browser.window.close()));
		this._register(installEditorTestDom(this.browser, ['Node', 'Element', 'HTMLElement', 'HTMLButtonElement']));
		this.browser.window.HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number, y?: number): void {
			this.scrollLeft = typeof options === 'number' ? options : options?.left ?? this.scrollLeft;
			this.scrollTop = typeof options === 'number' ? y ?? this.scrollTop : options?.top ?? this.scrollTop;
		};
		this.browser.window.HTMLDialogElement.prototype.showModal = function (): void { this.setAttribute('open', ''); };
		this.browser.window.HTMLDialogElement.prototype.close = function (): void {
			this.removeAttribute('open');
			this.dispatchEvent(new fixtureEvent('close'));
		};
		const fixtureEvent = this.browser.window.Event;
		this.services.registerInstance(ILayoutService, { mainContainer: this.browser.window.document.body } as ILayoutService);
		this.services.registerInstance(IContextKeyService, this.contextKeys);
		this.services.registerInstance(IConfigurationService, this.configuration);
		this.services.registerInstance(IKeybindingService, this.keybindings);
		this.accessibility = this._register(new AccessibilityService({ root: this.browser.window.document.body, contextKeyService: this.contextKeys, configurationService: this.configuration }));
		this.services.registerInstance(IAccessibilityService, this.accessibility);
		this.services.registerInstance(ICodeEditorService, this.codeEditors);
		this.services.registerInstance(IStatusbarService, this.statusbar);
		this.services.registerInstance(INotificationService, this.notifications);
		this.accessibleView = this._register(this.services.createInstance(AccessibleViewService));
		this.services.registerInstance(IAccessibleViewService, this.accessibleView);
		this.commands = this._register(new CommandService(this.services));
		this.services.registerInstance(ICommandService, this.commands);
	}
}
