import { Disposable } from '../../../../../base/common/lifecycle.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService, DialogResult } from '../../../../../platform/dialogs/common/dialogs.js';
import { DialogService } from '../../../../services/dialogs/common/dialogService.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { BrowserKeyboardLayoutService } from '../../../../services/keybinding/browser/keyboardLayoutService.js';
import { WorkbenchKeybindingService } from '../../../../services/keybinding/browser/keybindingService.js';
import { NotificationService } from '../../../../services/notification/common/notificationService.js';
import { TraceEditor } from '../../../trace/browser/traceEditor.js';
import '../../browser/accessibleViewActions.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { AccessibilityVerbositySettingId, AccessibleViewType, IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import type { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import '../../browser/accessibilityConfiguration.js';
import { AccessibleViewService } from '../../browser/accessibleView.js';

test('Explorer accessibility hint follows the verbosity setting', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	using configuration = new InMemoryConfigurationService();
	using contextKeys = new ContextKeyService();
	using services = new InstantiationService();
	using accessibleView = new AccessibleViewService({ mainContainer: browser.window.document.body } as ILayoutService, contextKeys, configuration, services);
	try {
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
	} finally {
		browser.window.close();
	}
});

test('Alt+F1 reaches focused local help through capture routing and keeps shared help outside it', async () => {
	const browser = new JSDOM('<!doctype html><body><button>Editor</button><main></main></body>');
	try {
		using configuration = new InMemoryConfigurationService();
		using contextKeys = new ContextKeyService();
		using services = new InstantiationService();
		using dialogs = new DialogService();
		const sharedHelp: AccessibleViewType[] = [];
		services.registerInstance(IContextKeyService, contextKeys);
		services.registerInstance(IConfigurationService, configuration);
		services.registerInstance(IDialogService, dialogs);
		services.registerInstance(IAccessibleViewService, {
			show: type => { sharedHelp.push(type); return true; },
			getOpenAriaHint: () => undefined,
			...Disposable.None,
		});
		using commands = new CommandService(services);
		using keyboardLayout = new BrowserKeyboardLayoutService({ navigator: browser.window.navigator, operatingSystem: OperatingSystem.Windows });
		using notifications = new NotificationService();
		using keybindings = new WorkbenchKeybindingService({ ownerDocument: browser.window.document, commandService: commands, contextKeyService: contextKeys, keyboardLayoutService: keyboardLayout }, notifications);
		using trace = services.createInstance(TraceEditor);
		trace.create(browser.window.document.querySelector('main')!);
		const filter = browser.window.document.querySelector<HTMLInputElement>('[aria-label="Filter by name, outcome or trace ID"]')!;
		const pressHelp = (element: HTMLElement): void => {
			element.focus();
			const event = new browser.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'F1', code: 'F1', altKey: true });
			Object.defineProperty(event, 'keyCode', { value: 112 });
			element.dispatchEvent(event);
			assert.equal(event.defaultPrevented, true);
		};

		pressHelp(filter);
		assert.equal(dialogs.model.dialogs[0]?.request.title, 'Trace viewer help');
		assert.deepEqual(sharedHelp, []);
		dialogs.model.dialogs[0]!.close({ button: DialogResult.Primary });
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(browser.window.document.activeElement, filter);

		pressHelp(browser.window.document.querySelector('button')!);
		assert.deepEqual(sharedHelp, [AccessibleViewType.Help]);
		assert.equal(dialogs.model.dialogs.length, 0);
	} finally {
		browser.window.close();
	}
});
