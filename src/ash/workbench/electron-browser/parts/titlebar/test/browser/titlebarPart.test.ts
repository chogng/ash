import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { isMacintosh } from '../../../../../../base/common/platform.js';
import { DisposableStore, DisposableTracker, installDisposableTracker } from '../../../../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { IMenubarService } from '../../../../../../platform/menubar/electron-browser/menubar.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../services/notification/test/common/testNotificationService.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { TestThemeService } from '../../../../../../platform/theme/test/common/testThemeService.js';
import { darkColorTheme, lightColorTheme } from '../../../../../../platform/theme/common/colorTheme.js';
import { INativeHostService } from '../../../../../common/services.js';
import type { INativeWindowTheme } from '../../../../../../platform/native/common/nativeHost.js';
import type { IEditorGroup, IEditorGroupsContainer } from '../../../../../services/editor/common/editorGroupsService.js';
import { readFileSync } from 'node:fs';
import { setNlsMessages, resetNlsResolver } from '../../../../../../nls.js';
import type { IWindowAlwaysOnTopChangedEvent } from '../../../../../../platform/window/common/window.js';
import { DeferredPromise } from '../../../../../../base/common/async.js';

const environment = new JSDOM('<!doctype html><body></body>');
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({ window: environment.window, document: environment.window.document, Node: environment.window.Node, Element: environment.window.Element, HTMLElement: environment.window.HTMLElement, navigator: environment.window.navigator })) {
	previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, name, { configurable: true, value });
}
suiteTeardown(() => {
	environment.window.close();
	for (const [name, descriptor] of previous) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
});

const { ILocalizationService } = await import('../../../../../services/localization/common/localizationService.js');
const { createElectronTitlebarPartFactory } = await import('../../../../../services/title/electron-browser/titleService.js');
const { MenuService } = await import('../../../../../../platform/actions/common/menuService.js');
const { IMenuService, registerAction2 } = await import('../../../../../../platform/actions/common/actions.js');
const { IContextMenuService } = await import('../../../../../../platform/contextview/browser/contextView.js');
const { ContextKeyService, IContextKeyService } = await import('../../../../../../platform/contextkey/browser/contextKeyService.js');
const { CommandService } = await import('../../../../../services/commands/common/commandService.js');
const { registerTestComponentServices, createTestEditorServices } = await import('../../../../../test/common/testEditorServices.js');
const { ElectronTitleService } = await import('../../titlebarPart.js');
const { EnableWindowAlwaysOnTopAction, DisableWindowAlwaysOnTopAction } = await import('../../../../actions/windowActions.js');
const { registerWindow } = await import('../../../../../../base/browser/window.js');

test('Electron titlebars apply the active theme and release their subscriptions with each part', async () => {
	const tracker = new DisposableTracker();
	using tracking = installDisposableTracker(tracker);
	{
		using services = new InstantiationService();
		using themes = new TestThemeService(darkColorTheme);
		using commands = new CommandService(services);
		using contextKeys = new ContextKeyService();
		const menus = new MenuService(commands, contextKeys);
		services.registerInstance(IContextKeyService, contextKeys);
		using actionRegistrations = new DisposableStore();
		const registerPinActions = (): void => {
			actionRegistrations.clear();
			actionRegistrations.add(registerAction2(EnableWindowAlwaysOnTopAction));
			actionRegistrations.add(registerAction2(DisableWindowAlwaysOnTopAction));
		};
		registerPinActions();
		services.registerInstance(IMenuService, menus);
		services.registerInstance(ICommandService, commands);
		services.registerInstance(IQuickInputService, { quickAccess: { onDidChangeVisibility: Event.None, show() { } } } as IQuickInputService);
		const applied: INativeWindowTheme[] = [];
		let titleBarStyle: 'custom' | 'system' = 'custom';
		using pinChanges = new Emitter<IWindowAlwaysOnTopChangedEvent>();
		let pinned = false;
		let pinRead: Promise<void> | undefined;
		const pinTargets: (string | undefined)[] = [];
		services.registerInstance(IThemeService, themes);
		registerTestComponentServices(services, environment.window.document);
		services.registerInstance(INativeHostService, {
			onDidSuspendOS: () => ({ dispose() { } }),
			onDidResumeOS: () => ({ dispose() { } }),
			getScreenshot: async () => { throw new Error('Unused screenshot capability'); },
			moveTerminalToWindow: async () => { throw new Error('Unexpected terminal transfer'); },
			takeTerminalTransfer: async () => undefined,
			completeTerminalTransfer: async () => { throw new Error('Unexpected terminal transfer completion'); },
			onDidRequestTerminalTransfer: () => ({ dispose() { } }),
			getAgentHostEditorState: () => { throw new Error('Unused invitation capability'); },
			updateAgentHostEditorState: () => { throw new Error('Unused invitation capability'); },
			claimAgentsWindowInvitation: () => { throw new Error('Unused invitation capability'); },
			markAgentsWindowInvitationShown: () => { throw new Error('Unused invitation capability'); },
			releaseAgentsWindowInvitation: () => { throw new Error('Unused invitation capability'); },
			onDidChangeAgentHostEditorState: () => { throw new Error('Unused invitation capability'); },
			getTitleBarStyle: async () => titleBarStyle,
			getWindowClientSize: async () => undefined,
			onDidChangeWindowClientSize: () => ({ dispose() { } }),
			isAdmin: async () => false,
			onDidRequestOpenExternalUri: () => ({ dispose() { } }),
			openExternal: async () => { throw new Error('unused'); },
			showMessageBox: async () => { throw new Error('unused'); },
			listWindows: async () => [],
			focusWindowById: async () => { },
			focusWindow: async () => { },
			closeWindow: async () => { },
			closeOtherWindows: async () => { },
			getZoomLevel: async () => 0,
			onDidChangeZoomLevel: () => ({ dispose() { } }),
			setZoomLevel: async () => { },
			getAuxiliaryWindowState: async () => { throw new Error('Unused window state'); },
			onDidChangeAuxiliaryWindowState: () => ({ dispose() { } }),
			onDidChangeWindowAlwaysOnTop: pinChanges.event,
			isAlwaysOnTop: async () => { const snapshot = pinned; await pinRead; return snapshot; },
			setAlwaysOnTop: async (enabled, windowName) => {
				pinned = enabled;
				pinTargets.push(windowName);
				pinChanges.fire({ windowName, alwaysOnTop: enabled });
			},
			performNativeTabAction: async () => { },
			openNewWindowTab: async () => { },
			setWindowTheme: async theme => { applied.push(theme); },
			setWindowDimmed: async () => { },
			pickFolder: async () => undefined,
			showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
			openWorkspace: async () => { },
			openWindow: async () => { },
			openAgentsWindow: async () => { },
			syncSystemWideKeybindings: async () => ({ failed: [] }),
			revealFile: async () => { },
			toggleDeveloperTools: async () => { },
			showSaveDialog: async () => ({ canceled: true, filePath: '' }),
			getOSColorScheme: async () => ({ dark: false, highContrast: false }),
			onDidChangeColorScheme: () => ({ dispose() { } }),
			isAccessibilitySupportEnabled: async () => false,
			onDidChangeAccessibilitySupport: () => ({ dispose() { } }),
		});
		services.registerInstance(IMenubarService, { _serviceBrand: undefined, updateMenubar: async () => { }, onDidSelect: Event.None });
		using notifications = new TestNotificationService();
		services.registerInstance(INotificationService, notifications);
		const factory = createElectronTitlebarPartFactory();
		const options = {
			windowTitle: { value: 'Ash Code', onDidChange: Event.None, updateProperties() { }, registerVariables() { } },
			menuService: menus,
			contextMenuService: { contextMenuStyle: 'custom' as const, onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu() { }, hideContextMenu() { } },
			localizationService: { whenReady: Promise.resolve(), translate: (_bundle: string, _key: string, fallback: string) => fallback },
		};
		services.registerInstance(IContextMenuService, options.contextMenuService);
		services.registerInstance(ILocalizationService, options.localizationService);
		using missingServices = new InstantiationService();
		assert.throws(() => factory(environment.window.document.body, { windowTitle: options.windowTitle }, missingServices), /service/i);
		using titlebar = factory(environment.window.document.body, { windowTitle: options.windowTitle }, services);
		const leftActions = titlebar.domNode.querySelector('.ash-titlebar-left-actions');
		assert.ok(leftActions);
		assert.equal(leftActions?.getAttribute('role'), 'toolbar');
		assert.equal(leftActions.querySelector('[data-action-id="ash.applicationMenu"]') === null, isMacintosh);
		themes.setColorTheme(lightColorTheme);
		assert.deepEqual(applied, [darkColorTheme, lightColorTheme].map(theme => ({ backgroundColor: theme.getColorCss('titleBar.background'), symbolColor: theme.getColorCss('titleBar.actionForeground'), backdropColor: theme.getColorCss('dialog.backdropBackground') })));
		titlebar.dispose();
		themes.setColorTheme(darkColorTheme);
		assert.equal(applied.length, 2);
		assert.equal(environment.window.document.querySelector('.ash-electron-titlebar'), null);
		using editorServices = createTestEditorServices(undefined, services, environment.window.document);
		const groups: IEditorGroupsContainer = {
			activeGroup: { createEditorActions: () => ({ actions: { primary: [], secondary: [] }, onDidChange: Event.None }), activeInput: undefined, onDidChangeEditors: Event.None } as unknown as IEditorGroup,
			onDidChangeActiveGroup: Event.None,
		};
		using titleService = editorServices.createInstance(ElectronTitleService, environment.window.document.body, 'Ash Code', factory, groups);
		const popup = new JSDOM('<!doctype html><body></body>');
		popup.window.name = 'ash-auxiliary-12345678-1234-1234-1234-123456789abc';
		using registration = registerWindow(popup.window as unknown as Window);
		try {
			const auxiliary = titleService.createAuxiliaryTitlebarPart(popup.window.document.body, groups, editorServices);
			await Promise.resolve();
			assert.equal(auxiliary.container.classList.contains('ash-electron-titlebar'), true);
			assert.equal(auxiliary.container.querySelector('[data-action-id="ash.applicationMenu"]') === null, isMacintosh);
			assert.equal(titleService.getPart(popup.window.document.body), auxiliary);
			// Ordinary auxiliary windows and compact tools use the same menu-backed toolbar.
			const action = (enabled: boolean): HTMLButtonElement | null => auxiliary.container.querySelector(
				`[data-action-id="workbench.action.${enabled ? 'enable' : 'disable'}WindowAlwaysOnTop"] button`,
			);
			assert.equal(titleService.getPart(environment.window.document.body).domNode.querySelector('[data-action-id="workbench.action.enableWindowAlwaysOnTop"]'), null);
			assert.equal(action(true)?.closest('[role="toolbar"]')?.parentElement?.className, 'ash-titlebar-actions ash-titlebar-interactive-region');
			assert.equal(action(true)?.getAttribute('aria-label'), 'Turn On Always on Top');
			const focusedRead = new DeferredPromise<void>();
			pinRead = focusedRead.p;
			action(true)!.focus();
			popup.window.dispatchEvent(new popup.window.Event('focus'));
			action(true)!.click();
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(action(false)?.getAttribute('aria-label'), 'Turn Off Always on Top');
			assert.deepEqual(pinTargets, [popup.window.name]);
			pinRead = undefined;
			await focusedRead.complete();
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.ok(action(false), 'A stale focus read must not replace the state received from the host event');
			pinChanges.fire({ windowName: 'ash-auxiliary-aaaaaaaa-1234-1234-1234-123456789abc', alwaysOnTop: false });
			assert.ok(action(false), 'Another window must not change this toolbar');
			pinned = false;
			pinChanges.fire({ windowName: popup.window.name, alwaysOnTop: false });
			assert.ok(action(true));
			auxiliary.updateOptions({ compact: true });
			assert.ok(action(true)?.closest('[role="toolbar"]'));
			try {
				setNlsMessages('zh-CN', JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/workbench.json', 'utf8')));
				registerPinActions();
				assert.equal(action(true)?.getAttribute('aria-label'), '窗口置顶');
				action(true)!.focus();
				action(true)!.click();
				await new Promise<void>(resolve => setImmediate(resolve));
				assert.equal(action(false)?.getAttribute('aria-label'), '取消窗口置顶');
			} finally { resetNlsResolver(); }

			const beforeThemeChange = applied.length;
			themes.setColorTheme(lightColorTheme);
			assert.equal(applied.length, beforeThemeChange + 2);
			auxiliary.dispose();
			themes.setColorTheme(darkColorTheme);
			assert.equal(applied.length, beforeThemeChange + 3);
			assert.equal(popup.window.document.querySelector('.ash-electron-titlebar'), null);
			titleBarStyle = 'system';
			const systemTitlebar = titleService.createAuxiliaryTitlebarPart(popup.window.document.body, groups, editorServices);
			await Promise.resolve();
			assert.equal(systemTitlebar.container.classList.contains('ash-electron-titlebar'), false);
			systemTitlebar.dispose();
		} finally {
			titleService.dispose();
			popup.window.close();
		}
	}
	tracker.assertNoLeaks();
});
