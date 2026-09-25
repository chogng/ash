import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { Event } from '../../../../../../base/common/event.js';
import { DisposableTracker, installDisposableTracker } from '../../../../../../base/common/lifecycle.js';
import { ServiceContainer } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IQuickAccessController } from '../../../../../../platform/quickinput/common/quickAccess.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { TestThemeService } from '../../../../../../platform/theme/test/common/testThemeService.js';
import { darkColorTheme, lightColorTheme } from '../../../../../../platform/theme/common/colorTheme.js';
import { INativeHostService } from '../../../../../common/services.js';
import type { INativeWindowTheme } from '../../../../../../platform/native/common/nativeHost.js';

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

const { createElectronTitlebarPartFactory } = await import('../../titlebarPart.js');
const { MenuService } = await import('../../../../../../platform/actions/common/menuService.js');
const { ContextKeyService } = await import('../../../../../../platform/contextkey/browser/contextKeyService.js');
const { CommandService } = await import('../../../../../services/commands/common/commandService.js');

test('Electron titlebar applies the active theme and releases its subscription with the part', () => {
	const tracker = new DisposableTracker();
	using tracking = installDisposableTracker(tracker);
	{
		using services = new ServiceContainer();
		using themes = new TestThemeService(darkColorTheme);
		using commands = new CommandService(services);
		using contextKeys = new ContextKeyService();
		const menus = new MenuService(commands, contextKeys);
		services.registerInstance(ICommandService, commands);
		services.registerInstance(IQuickAccessController, { onDidChangeVisibility: Event.None, show() {} });
		const applied: INativeWindowTheme[] = [];
		services.registerInstance(IThemeService, themes);
		services.registerInstance(INativeHostService, {
			setWindowTheme: async theme => { applied.push(theme); },
			openFolder: async () => {},
			pickFolder: async () => undefined,
			openWorkspace: async () => {},
			toggleDeveloperTools: async () => {},
			saveFile: async () => undefined,
			isAccessibilitySupportEnabled: async () => false,
			onDidChangeAccessibilitySupport: () => ({ dispose() {} }),
		});
		const factory = createElectronTitlebarPartFactory({ update: async () => {}, onDidSelect: () => ({ dispose() {} }) });
		const options = { menuService: menus, contextMenuService: { onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu() {}, hideContextMenu() {} } };
		using missingServices = new ServiceContainer();
		assert.throws(() => factory(environment.window.document.body, options, missingServices), /service/i);
		using titlebar = factory(environment.window.document.body, options, services);
		themes.setColorTheme(lightColorTheme);
		assert.deepEqual(applied, [darkColorTheme, lightColorTheme].map(theme => ({ backgroundColor: theme.getColorCss('titleBar.background'), symbolColor: theme.getColorCss('titleBar.actionForeground') })));
		titlebar.dispose();
		themes.setColorTheme(darkColorTheme);
		assert.equal(applied.length, 2);
		assert.equal(environment.window.document.querySelector('.ash-electron-titlebar'), null);
	}
	tracker.assertNoLeaks();
});
