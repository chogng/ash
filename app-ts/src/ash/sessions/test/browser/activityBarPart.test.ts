import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
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
const { ActivityBarPart } = await import('../../browser/parts/activitybar/activityBarPart.js');
const { SessionsPageRegistry } = await import('../../browser/pages.js');
const { SessionsPageService } = await import('../../services/pages/browser/sessionsPageService.js');
const { ISessionsPageService } = await import('../../common/pages.js');
const { IStorageService } = await import('../../../platform/storage/common/storage.js');
const { BrowserStorageService } = await import('../../../workbench/services/storage/browser/storageService.js');
const { autorun } = await import('../../../base/common/observable.js');
await import('../../sessions.common.main.js');
suiteTeardown(() => browser.window.close());
let storageSequence = 0;
const { SessionsConfiguration } = await import('../../common/configuration.js');
const { ActivityBarPosition, WorkbenchConfiguration } = await import('../../../workbench/common/configuration.js');
const { WorkbenchConfigurationService } = await import('../../../workbench/services/configuration/browser/configurationService.js');

test('Sessions Activity Bar selects Chat, Collaboration, Library, Code, and Design pages', async () => {
	const ownerDocument = browser.window.document;
	ownerDocument.body.replaceChildren();
	let listFocuses = 0;
	let accountAnchor: HTMLElement | undefined;
	const selectedPages: string[] = [];
	const contextMenu: IContextMenuService = {
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu() {},
		hideContextMenu() {},
	};
	const configuration = new WorkbenchConfigurationService();
	using contextViews = new BrowserContextViewService(ownerDocument.body);
	using hovers = new HoverService(configuration, contextViews, contextMenu);
	using services = new InstantiationService();
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IContextMenuService, contextMenu);
	services.registerInstance(IHoverService, hovers);
	using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, applicationId: `activity-test-${++storageSequence}`, workspaceId: 'sessions', flushInterval: 0 });
	services.registerInstance(IStorageService, storage);
	using pages = services.createInstance(SessionsPageService);
	services.registerInstance(ISessionsPageService, pages);
	using selection = autorun(reader => selectedPages.push(pages.activePage.read(reader)));
	const bar = services.createInstance(ActivityBarPart, ownerDocument.body, {
		focusList: () => { listFocuses++; },
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
			{ icon: 'library', disabled: false },
			{ icon: 'code', disabled: false },
			{ icon: 'symbol-color', disabled: false },
			{ icon: 'account', disabled: false },
		]);
		assert.deepEqual([...bar.domNode.querySelectorAll('.ash-sessions-activity-top, .ash-sessions-activity-bottom')].map(group =>
			[...group.querySelectorAll('button')].map(button => button.getAttribute('aria-label')),
		), [['Chat', 'Collaboration', 'Library', 'Code', 'Design'], ['Accounts']]);
		assert.ok(buttons.every(button => button.classList.contains('icon-only')));
		assert.equal(buttons[0]?.getAttribute('aria-current'), 'page');
		buttons[1]?.click();
		assert.deepEqual([buttons[0], buttons[1], buttons[2]].map(button => [button?.querySelector('svg')?.getAttribute('data-ash-icon-id'), button?.getAttribute('aria-current')]), [
			['chat-2', null], ['colab-filled', 'page'], ['library', null],
		]);
		buttons[2]?.click();
		assert.deepEqual([buttons[0], buttons[1], buttons[2]].map(button => [button?.querySelector('svg')?.getAttribute('data-ash-icon-id'), button?.getAttribute('aria-current')]), [
			['chat-2', null], ['colab', null], ['library-filled', 'page'],
		]);
		buttons[3]?.click();
		assert.deepEqual(buttons.slice(0, 4).map(button => [button.classList.contains('selected'), button.getAttribute('aria-current')]), [
			[false, null], [false, null], [false, null], [true, 'page'],
		]);
		buttons[4]?.click();
		assert.deepEqual([buttons[3], buttons[4]].map(button => [button?.querySelector('svg')?.getAttribute('data-ash-icon-id'), button?.getAttribute('aria-current')]), [
			['code', null], ['symbol-color-filled', 'page'],
		]);
		buttons[0]?.click();
		assert.deepEqual(selectedPages, ['chat', 'colab', 'library', 'code', 'design', 'chat']);
		assert.equal(buttons[0]?.getAttribute('aria-current'), 'page');
		assert.equal(buttons[4]?.getAttribute('aria-current'), null);
		assert.equal(listFocuses, 1);
		buttons[5]?.click();
		await Promise.resolve();
		assert.equal(accountAnchor, buttons[5]);
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
		hideContextMenu() {},
	};
	const configuration = new WorkbenchConfigurationService();
	using contextViews = new BrowserContextViewService(ownerDocument.body);
	using hovers = new HoverService(configuration, contextViews, contextMenu);
	using services = new InstantiationService();
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IContextMenuService, contextMenu);
	services.registerInstance(IHoverService, hovers);
	using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, applicationId: `activity-test-${++storageSequence}`, workspaceId: 'sessions', flushInterval: 0 });
	services.registerInstance(IStorageService, storage);
	using pages = services.createInstance(SessionsPageService);
	services.registerInstance(ISessionsPageService, pages);
	const bar = services.createInstance(ActivityBarPart, ownerDocument.body, { focusList() {}, async showAccountMenu() {} });
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
		showContextMenu() {},
		hideContextMenu() {},
	});
	assert.throws(() => services.createInstance(ActivityBarPart, browser.window.document.body, {
		focusList() {}, showAccountMenu() {},
	}), /hoverService/);
});

test('Sessions page order survives a new window and includes newly registered pages without changing selection', async () => {
	using services = new InstantiationService();
	using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, applicationId: `activity-test-${++storageSequence}`, workspaceId: 'sessions', flushInterval: 0 });
	services.registerInstance(IStorageService, storage);
	using pages = services.createInstance(SessionsPageService);
	pages.openPage('library');
	pages.movePage('design', 'chat', 'before');
	await storage.flush();
	using restoredStorage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, applicationId: `activity-test-${storageSequence}`, workspaceId: 'sessions', flushInterval: 0 });
	using restoredServices = new InstantiationService();
	restoredServices.registerInstance(IStorageService, restoredStorage);
	using restored = restoredServices.createInstance(SessionsPageService);
	assert.deepEqual({ page: restored.activePage.get(), order: restored.pages.get().map(page => page.id) }, {
		page: 'library', order: ['design', 'chat', 'colab', 'library', 'code'],
	});
	using contribution = SessionsPageRegistry.registerPage({
		id: 'test.page', title: 'Test page', titleKey: 'test.page', icon: restored.getPage('chat').icon, order: 60,
		layout: { sidebar: 'hidden', primary: 'sessions', editor: 'hidden', auxiliaryBar: 'hidden', panel: false },
	});
	assert.deepEqual(restored.pages.get().map(page => page.id), ['design', 'chat', 'colab', 'library', 'code', 'test.page']);
});

test('Sessions registered page labels and ordering menu use the Chinese language catalog', async () => {
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
		const menus: IContextMenuService = { onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu(delegate) { actions = delegate.getActions!(); }, hideContextMenu() {} };
		using hovers = new HoverService(configuration, contextViews, menus);
		using services = new InstantiationService();
		services.registerInstance(IConfigurationService, configuration);
		services.registerInstance(IContextMenuService, menus);
		services.registerInstance(IHoverService, hovers);
		using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, applicationId: `activity-test-${++storageSequence}`, workspaceId: 'sessions', flushInterval: 0 });
		services.registerInstance(IStorageService, storage);
		using pages = services.createInstance(SessionsPageService);
		services.registerInstance(ISessionsPageService, pages);
		using bar = services.createInstance(ActivityBarPart, ownerDocument.body, { focusList() {}, showAccountMenu() {} });
		const buttons = [...bar.domNode.querySelectorAll('button')];
		buttons[1]!.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
		assert.deepEqual({ titles: buttons.slice(0, 5).map(button => button.getAttribute('aria-label')), moves: actions.slice(0, 2).map(action => action.label) }, {
			titles: ['聊天', '协作', '资料库', '代码', '设计'], moves: ['向前移动', '向后移动'],
		});
	} finally {
		resetNlsResolver();
	}
});
