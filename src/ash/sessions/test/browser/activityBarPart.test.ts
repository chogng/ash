import { registerTestComponentServices } from '../../../workbench/test/common/testEditorServices.js';
import assert from 'node:assert/strict';
import { setup, test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import type { IAction } from '../../../base/common/actions.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';

const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
for (const [name, value] of Object.entries({
	window: browser.window,
	document: browser.window.document,
	Node: browser.window.Node,
	Element: browser.window.Element,
	HTMLElement: browser.window.HTMLElement,
	Event: browser.window.Event,
	MouseEvent: browser.window.MouseEvent,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { InstantiationService } = await import('../../../platform/instantiation/common/instantiationService.js');
const { IConfigurationService } = await import('../../../platform/configuration/common/configuration.js');
const { BrowserContextViewService } = await import('../../../platform/contextview/browser/contextViewService.js');
const { HoverService, IHoverService } = await import('../../../platform/hover/browser/hoverService.js');
const { Event } = await import('../../../base/common/event.js');
const { setARIAContainer } = await import('../../../base/browser/ui/aria/aria.js');
const { ActivityBarPart } = await import('../../browser/parts/activitybar/activityBarPart.js');
const { TitlebarPart } = await import('../../browser/parts/titlebar/titlebarPart.js');
const { MenusRegistry, IMenuService } = await import('../../../platform/actions/common/actions.js');
const { MenuService } = await import('../../../platform/actions/common/menuService.js');
const { ContextKeyService, IContextKeyService } = await import('../../../platform/contextkey/browser/contextKeyService.js');
const { CommandRegistry, CommandsRegistry, ICommandService } = await import('../../../platform/commands/common/commands.js');
const { CommandService } = await import('../../../workbench/services/commands/common/commandService.js');
const { IEditorService } = await import('../../../workbench/services/editor/common/editorService.js');
const { IDesignEditorService } = await import('../../contrib/creator/browser/designEditorService.js');
const { URI } = await import('../../../base/common/uri.js');
const { DisposableStore } = await import('../../../base/common/lifecycle.js');
const { Menus } = await import('../../browser/menus.js');
const { Lxicon } = await import('../../../base/common/lxicons.js');
const { IStorageService, StorageScope, StorageTarget } = await import('../../../platform/storage/common/storage.js');
const { BrowserStorageService } = await import('../../../workbench/services/storage/browser/storageService.js');
await import('../../sessions.common.main.js');
suiteTeardown(() => browser.window.close());
setup(() => browser.window.localStorage.clear());
const { SessionsConfiguration } = await import('../../common/configuration.js');
const { ActivityBarPosition, WorkbenchConfiguration } = await import('../../../workbench/common/configuration.js');
const { WorkbenchConfigurationService } = await import('../../../workbench/services/configuration/browser/configurationService.js');

test('Sessions Activity Bar selects Chat, Collaboration, Library, Code, and Creator actions', async () => {
	const ownerDocument = browser.window.document;
	ownerDocument.body.replaceChildren();
	let accountAnchor: HTMLElement | undefined;
	const selectedActions: string[] = [];
	const contextMenu: IContextMenuService = {
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu() { },
		hideContextMenu() { },
	};
	const configuration = new WorkbenchConfigurationService();
	using contextViews = new BrowserContextViewService(ownerDocument.body);
	using hovers = new HoverService(configuration, contextViews, contextMenu);
	using services = new InstantiationService();
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IContextMenuService, contextMenu);
	services.registerInstance(IHoverService, hovers);
	using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'sessions', flushInterval: 0 });
	services.registerInstance(IStorageService, storage);
	using menuServices = registerMenus(services);
	using executed = services.get(ICommandService).onWillExecuteCommand(event => { if (event.commandId.startsWith('sessions.open.')) { selectedActions.push(event.commandId.slice('sessions.open.'.length)); } });
	selectedActions.push('chat');
	const bar = registerTestComponentServices(services).createInstance(ActivityBarPart, ownerDocument.body, {
		showAccountMenu: async (anchor: HTMLElement) => { accountAnchor = anchor; },
	});
	try {
		const buttons = [...bar.domNode.querySelectorAll<HTMLButtonElement>('button')];
		assert.deepEqual(buttons.map(button => ({
			icon: button.querySelector('svg')?.getAttribute('data-ash-icon-id'),
			disabled: button.disabled,
		})), [
			{ icon: 'chat-2-filled', disabled: false },
			{ icon: 'colab', disabled: false },
			{ icon: 'projects', disabled: false },
			{ icon: 'code', disabled: false },
			{ icon: 'symbol-color', disabled: false },
			{ icon: 'history', disabled: false },
			{ icon: 'account', disabled: false },
		]);
		assert.deepEqual([...bar.domNode.querySelectorAll('.ash-sessions-activity-top, .ash-sessions-activity-bottom')].map(group =>
			[...group.querySelectorAll('button')].map(button => button.getAttribute('aria-label')),
		), [['Chat', 'Collaboration', 'Library', 'Code', 'Creator', 'Trace'], ['Accounts']]);
		assert.ok(buttons.every(button => button.classList.contains('icon-only')));
		assert.equal(bar.domNode.querySelectorAll('.ash-composite-bar-navigation-item > button.ash-sessions-activity-item').length, 6);
		assert.equal(bar.domNode.querySelectorAll('.ash-composite-bar-navigation-item.checked').length, 1);
		assert.equal(buttons[0]?.getAttribute('aria-current'), 'page');
		buttons[1]?.click();
		assert.deepEqual([buttons[0], buttons[1], buttons[2]].map(button => [button?.querySelector('svg')?.getAttribute('data-ash-icon-id'), button?.getAttribute('aria-current')]), [
			['chat-2', null], ['colab-filled', 'page'], ['projects', null],
		]);
		buttons[2]?.click();
		assert.deepEqual([buttons[0], buttons[1], buttons[2]].map(button => [button?.querySelector('svg')?.getAttribute('data-ash-icon-id'), button?.getAttribute('aria-current')]), [
			['chat-2', null], ['colab', null], ['projects-filled', 'page'],
		]);
		buttons[3]?.click();
		assert.deepEqual(buttons.slice(0, 4).map(button => [button.parentElement!.classList.contains('checked'), button.getAttribute('aria-current')]), [
			[false, null], [false, null], [false, null], [true, 'page'],
		]);
		buttons[4]?.click();
		assert.deepEqual([buttons[3], buttons[4]].map(button => [button?.querySelector('svg')?.getAttribute('data-ash-icon-id'), button?.getAttribute('aria-current')]), [
			['code', null], ['symbol-color-filled', 'page'],
		]);
		buttons[0]?.click();
		assert.deepEqual(selectedActions, ['chat', 'teams', 'library', 'code', 'creator', 'chat']);
		assert.equal(buttons[0]?.getAttribute('aria-current'), 'page');
		assert.equal(buttons[4]?.getAttribute('aria-current'), null);
		buttons[6]?.click();
		await Promise.resolve();
		assert.equal(accountAnchor, buttons[6]);
		using titlebar = registerTestComponentServices(services).createInstance(TitlebarPart, ownerDocument.body, 'application-menu');
		const renderTitlebarAccount = (visible: boolean): void => titlebar.setActivityActions(visible ? [bar.accountAction] : [], (action, options) => bar.createAccountActionViewItem(action, options, 'titlebar'));
		for (const position of [ActivityBarPosition.TOP, ActivityBarPosition.BOTTOM]) {
			bar.setLocation(position, ownerDocument.body);
			renderTitlebarAccount(true);
			const account = titlebar.domNode.querySelector<HTMLButtonElement>('[data-action-id="sessions.activity.accounts"] button')!;
			assert.deepEqual({ railAccounts: bar.focusContainer.querySelectorAll('[data-action-id="sessions.activity.accounts"]').length, titlebarAccounts: titlebar.domNode.querySelectorAll('[data-action-id="sessions.activity.accounts"]').length, menu: account.getAttribute('aria-haspopup') }, { railAccounts: 0, titlebarAccounts: 1, menu: 'menu' });
			account.click();
			assert.equal(accountAnchor, account);
		}
		bar.setLocation(ActivityBarPosition.DEFAULT, undefined);
		renderTitlebarAccount(false);
		assert.deepEqual({ railAccounts: bar.focusContainer.querySelectorAll('[data-action-id="sessions.activity.accounts"]').length, titlebarAccounts: titlebar.domNode.querySelectorAll('[data-action-id="sessions.activity.accounts"]').length }, { railAccounts: 1, titlebarAccounts: 0 });
	} finally {
		bar.dispose();
		configuration.dispose();
	}
});

test('Sessions Activity Bar context menu changes its own position and size settings', async () => {
	const ownerDocument = browser.window.document;
	ownerDocument.body.replaceChildren();
	let shownActions: readonly IAction[] = [];
	const contextMenu: IContextMenuService = {
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu(delegate) { shownActions = delegate.getActions?.() ?? []; },
		hideContextMenu() { },
	};
	const configuration = new WorkbenchConfigurationService();
	using contextViews = new BrowserContextViewService(ownerDocument.body);
	using hovers = new HoverService(configuration, contextViews, contextMenu);
	using services = new InstantiationService();
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IContextMenuService, contextMenu);
	services.registerInstance(IHoverService, hovers);
	using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'sessions', flushInterval: 0 });
	services.registerInstance(IStorageService, storage);
	using menuServices = registerMenus(services);
	const bar = registerTestComponentServices(services).createInstance(ActivityBarPart, ownerDocument.body, { async showAccountMenu() { } });
	try {
		bar.domNode.querySelector('.ash-sessions-activity-content')?.dispatchEvent(new browser.window.MouseEvent('contextmenu', { bubbles: true, button: 2 }));
		assert.deepEqual(shownActions.map(action => action.label), ['Activity Bar Position', 'Activity Bar Size']);
		const position = shownActions[0] as import('../../../base/common/actions.js').SubmenuAction;
		const size = shownActions[1] as import('../../../base/common/actions.js').SubmenuAction;
		assert.deepEqual(position.actions.map(action => [action.label, action.checked]), [
			['Default', true], ['Top', false], ['Bottom', false], ['Hidden', false],
		]);
		await size.actions[1]!.run();
		assert.equal(configuration.getValue(SessionsConfiguration.activityBarCompact), true);
		bar.setCompact(true);
		assert.equal(bar.minimumWidth, 36);
		await position.actions[1]!.run();
		assert.equal(configuration.getValue(SessionsConfiguration.activityBarLocation), ActivityBarPosition.TOP);
		assert.equal(configuration.getValue(WorkbenchConfiguration.activityBarLocation), ActivityBarPosition.DEFAULT);
		assert.equal(configuration.getValue(WorkbenchConfiguration.activityBarCompact), false);
		bar.domNode.querySelector('button')?.dispatchEvent(new browser.window.KeyboardEvent('keydown', { bubbles: true, key: 'F10', shiftKey: true }));
		assert.deepEqual(shownActions.map(action => action.label), ['Move earlier', 'Move later', '', 'Activity Bar Position']);
	} finally {
		bar.dispose();
		configuration.dispose();
	}
});

test('Sessions Activity Bar requires its window Hover service during creation', () => {
	using configuration = new WorkbenchConfigurationService();
	using services = new InstantiationService();
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IContextMenuService, {
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu() { },
		hideContextMenu() { },
	});
	using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'sessions', flushInterval: 0 });
	services.registerInstance(IStorageService, storage);
	using menuServices = registerMenus(services);
	assert.throws(() => registerTestComponentServices(services).createInstance(ActivityBarPart, browser.window.document.body, {
		showAccountMenu() { },
	}), /hoverService/);
});

test('navigation order survives a new window and includes new menu contributions', async () => {
	using configuration = new WorkbenchConfigurationService();
	using contextViews = new BrowserContextViewService(document.body);
	let shownActions: readonly IAction[] = [];
	const contextMenu: IContextMenuService = { onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu(delegate) { shownActions = delegate.getActions!(); }, hideContextMenu() { } };
	using hovers = new HoverService(configuration, contextViews, contextMenu);
	using services = new InstantiationService();
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IContextMenuService, contextMenu);
	services.registerInstance(IHoverService, hovers);
	using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'sessions', flushInterval: 0 });
	services.registerInstance(IStorageService, storage);
	using menuServices = registerMenus(services);
	storage.store('sessions.activityBar.actionOrder', JSON.stringify(['sessions.open.chat', 'sessions.open.teams', 'sessions.open.library', 'sessions.open.code', 'sessions.open.design']), StorageScope.PROFILE, StorageTarget.USER);
	using bar = registerTestComponentServices(services).createInstance(ActivityBarPart, document.body, { showAccountMenu() { } });
	assert.equal(storage.get('sessions.activityBar.actionOrder', StorageScope.PROFILE), JSON.stringify(['sessions.open.chat', 'sessions.open.teams', 'sessions.open.library', 'sessions.open.code', 'sessions.open.creator']));
	setARIAContainer(document.body);
	const buttons = [...bar.domNode.querySelectorAll<HTMLButtonElement>('button')];
	buttons[4]!.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
	await shownActions[0]!.run();
	assert.equal(bar.domNode.querySelectorAll('button')[3], buttons[4]);
	await storage.flush();
	using restored = registerTestComponentServices(services).createInstance(ActivityBarPart, document.body, { showAccountMenu() { } });
	assert.deepEqual([...restored.domNode.querySelectorAll('button')].slice(0, 5).map(button => button.getAttribute('aria-label')), ['Chat', 'Collaboration', 'Library', 'Creator', 'Code']);
	using contribution = MenusRegistry.appendMenuItem(Menus.ActivityBar, { command: { id: 'test.activity', title: 'Test action', icon: Lxicon.chat2 }, order: 60 });
	assert.deepEqual([...restored.domNode.querySelectorAll('button')].map(button => button.getAttribute('aria-label')), ['Chat', 'Collaboration', 'Library', 'Creator', 'Code', 'Trace', 'Test action', 'Accounts']);
	assert.equal(restored.domNode.querySelector('button')!.getAttribute('aria-current'), 'page');
});

test('navigation and ordering labels use the Chinese language catalog', async () => {
	const { setNlsResolver, resetNlsResolver, formatNlsMessage } = await import('../../../nls.js');
	const { builtinLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, message, parameters) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? message, parameters));
	try {
		const ownerDocument = browser.window.document;
		ownerDocument.body.replaceChildren();
		using configuration = new WorkbenchConfigurationService();
		using contextViews = new BrowserContextViewService(ownerDocument.body);
		let actions: readonly IAction[] = [];
		const menus: IContextMenuService = { onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu(delegate) { actions = delegate.getActions!(); }, hideContextMenu() { } };
		using hovers = new HoverService(configuration, contextViews, menus);
		using services = new InstantiationService();
		services.registerInstance(IConfigurationService, configuration);
		services.registerInstance(IContextMenuService, menus);
		services.registerInstance(IHoverService, hovers);
		using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'sessions', flushInterval: 0 });
		services.registerInstance(IStorageService, storage);
		using menuServices = registerMenus(services);
		using bar = registerTestComponentServices(services).createInstance(ActivityBarPart, ownerDocument.body, { showAccountMenu() { } });
		const buttons = [...bar.domNode.querySelectorAll('button')];
		buttons[1]!.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
		assert.deepEqual({ navigation: bar.domNode.querySelector('.ash-sessions-navigation')!.getAttribute('aria-label'), moves: actions.slice(0, 2).map(action => action.label) }, {
			navigation: '导航', moves: ['向前移动', '向后移动'],
		});
	} finally {
		resetNlsResolver();
	}
});

function registerMenus(services: InstanceType<typeof InstantiationService>): InstanceType<typeof DisposableStore> {
	const resources = new DisposableStore();
	const contexts = resources.add(new ContextKeyService());
	services.registerInstance(IContextKeyService, contexts);
	const registry = new CommandRegistry();
	const commands = resources.add(new CommandService(services, registry));
	services.registerInstance(ICommandService, commands);
	services.registerInstance(IMenuService, services.createInstance(MenuService));
	const keys = new Map(['chat', 'teams', 'library', 'code', 'creator'].map(id => [id, contexts.createKey<boolean>(`sessions.activity.${id}Selected`, id === 'chat')]));
	const select = (id: string): void => contexts.bufferChangeEvents(() => { for (const [candidate, key] of keys) { key.set(candidate === id); } });
	for (const id of ['chat', 'teams', 'code']) { resources.add(registry.register(`sessions.open.${id}`, () => select(id))); }
	for (const id of ['library', 'creator']) {
		resources.add(registry.register(`sessions.open.${id}`, CommandsRegistry.getCommand(`sessions.open.${id}`)!));
		resources.add(registry.register(`sessions.show.${id}`, () => select(id)));
	}
	services.registerInstance(IEditorService, { openEditor: async (input: { resource: { scheme: string; }; }) => select(input.resource.scheme === 'ash-library' ? 'library' : 'creator') } as unknown as import('../../../workbench/services/editor/common/editorService.js').IEditorService);
	services.registerInstance(IDesignEditorService, { input: { resource: URI.parse('ash-design:/canvas') } } as unknown as import('../../contrib/creator/browser/designEditorService.js').IDesignEditorService);
	return resources;
}
