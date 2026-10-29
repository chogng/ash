import { CancellationToken } from '../../../base/common/cancellation.js';
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
const { ActivityBar } = await import('../../browser/parts/activitybar/activityBarPart.js');
const { TitlebarPart } = await import('../../browser/parts/titlebarPart.js');
const { MenusRegistry, IMenuService } = await import('../../../platform/actions/common/actions.js');
const { MenuService } = await import('../../../platform/actions/common/menuService.js');
const { ContextKeyService, IContextKeyService } =
	await import('../../../platform/contextkey/browser/contextKeyService.js');
const { CommandRegistry, CommandsRegistry, ICommandService } =
	await import('../../../platform/commands/common/commands.js');
const { CommandService } = await import('../../../workbench/services/commands/common/commandService.js');
const { IEditorService } = await import('../../../workbench/services/editor/common/editorService.js');
const { ISessionsLayoutService } = await import('../../services/layout/common/sessionsLayoutService.js');
const { IDesignEditorService } = await import('../../contrib/creator/browser/designEditorService.js');
const { URI } = await import('../../../base/common/uri.js');
const { DisposableStore } = await import('../../../base/common/lifecycle.js');
const { Menus } = await import('../../browser/menus.js');
const { ActivityBarItemContext } = await import('../../common/contextkeys.js');
const { Lxicon } = await import('../../../base/common/lxicons.js');
const { IStorageService, StorageScope, StorageTarget } = await import('../../../platform/storage/common/storage.js');
const { BrowserStorageService } = await import('../../../workbench/services/storage/browser/storageService.js');
await import('../../sessions.common.main.js');
suiteTeardown(() => browser.window.close());
setup(() => browser.window.localStorage.clear());
const { SessionsConfiguration } = await import('../../common/configuration.js');
const { ActivityBarPosition, WorkbenchConfiguration } = await import('../../../workbench/common/configuration.js');
const { TestConfigurationService: WorkbenchConfigurationService } =
	await import('../../../workbench/services/configuration/test/common/testServices.js');

test('Sessions common entry registers the shared speech service for unavailable capture hosts', async () => {
	const { getSingletonServiceDescriptors } = await import('../../../platform/instantiation/common/extensions.js');
	const { ServiceCollection } = await import('../../../platform/instantiation/common/serviceCollection.js');
	const { IVoiceCodeTranscriptionBackendService } = await import('../../../platform/renderer/common/dictation.js');
	const { ISpeechService } = await import('../../../workbench/contrib/speech/common/speechService.js');
	const registrations = getSingletonServiceDescriptors().filter(([id]) => id === ISpeechService);
	assert.equal(registrations.length, 1);
	const { IExtensionService } = await import('../../../workbench/services/extensions/common/extensionService.js');
	using services = new InstantiationService(
		new ServiceCollection(
			...registrations,
			[IExtensionService, undefined],
			[IConfigurationService, undefined],
			[IContextKeyService, undefined],
		),
	);
	services.registerInstance(IVoiceCodeTranscriptionBackendService, undefined);
	const speech = services.get(ISpeechService);
	assert.equal(speech.hasSpeechProvider, false);
	await assert.rejects(speech.createSpeechToTextSession(CancellationToken.None), /No speech extension provider/);
	assert.equal(speech.hasActiveSpeechToTextSession, false);
});

test('Sessions common entry supplies the shared editor Worker service in each window scope', async () => {
	const { getSingletonServiceDescriptors } = await import('../../../platform/instantiation/common/extensions.js');
	const { ServiceCollection } = await import('../../../platform/instantiation/common/serviceCollection.js');
	const { IWebWorkerService } = await import('../../../platform/webWorker/browser/webWorkerService.js');
	const { WebWorkerService } = await import('../../../platform/webWorker/browser/webWorkerServiceImpl.js');
	const registrations = getSingletonServiceDescriptors().filter(([id]) => id === IWebWorkerService);
	assert.equal(registrations.length, 1);
	assert.equal(registrations[0][1].supportsDelayedInstantiation, true);
	using firstWindow = new InstantiationService(new ServiceCollection(...registrations));
	using secondWindow = new InstantiationService(new ServiceCollection(...registrations));
	const first = firstWindow.get(IWebWorkerService);
	assert.ok(first instanceof WebWorkerService);
	assert.equal(firstWindow.get(IWebWorkerService), first);
	assert.notEqual(secondWindow.get(IWebWorkerService), first);
});

test('Chat navigation includes Search and selects New, Projects, Creator and Customize with retained Accounts', async () => {
	const ownerDocument = browser.window.document;
	ownerDocument.body.replaceChildren();
	let accountAnchor: HTMLElement | undefined;
	const selectedActions: string[] = [];
	const contextMenu: IContextMenuService = {
		contextMenuStyle: 'custom' as const,
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
	using storage = new BrowserStorageService({
		ownerWindow: browser.window as unknown as Window,
		workspaceId: 'sessions',
		flushInterval: 0,
	});
	services.registerInstance(IStorageService, storage);
	using menuServices = registerMenus(services);
	using executed = services.get(ICommandService).onWillExecuteCommand(event => {
		if (event.commandId === 'sessions.newSession') {
			selectedActions.push('chat');
		} else if (event.commandId.startsWith('sessions.open.')) {
			selectedActions.push(event.commandId.slice('sessions.open.'.length));
		}
	});
	selectedActions.push('chat');
	const bar = registerTestComponentServices(services).createInstance(ActivityBar, ownerDocument.body, {
		showAccountMenu: async (anchor: HTMLElement) => {
			accountAnchor = anchor;
		},
	});
	try {
		const buttons = [...bar.domNode.querySelectorAll<HTMLButtonElement>('button')];
		assert.deepEqual(
			buttons.map(button => ({
				icon: button.querySelector('.ash-icon')?.getAttribute('data-ash-icon-id'),
				disabled: button.disabled,
			})),
			[
				{ icon: 'add', disabled: false },
				{ icon: 'search', disabled: false },
				{ icon: 'projects', disabled: false },
				{ icon: 'artifacts', disabled: false },
				{ icon: 'briefcase', disabled: false },
				{ icon: 'account', disabled: false },
			],
		);
		assert.deepEqual(
			[...bar.domNode.querySelectorAll('.ash-sessions-activity-top, .ash-sessions-activity-bottom')].map(group =>
				[...group.querySelectorAll('button')].map(button => button.textContent),
			),
			[['New', 'Search', 'Projects', 'Artifacts', 'Customize'], ['Accounts']],
		);
		assert.ok(buttons.every(button => !button.classList.contains('icon-only')));
		assert.equal(
			bar.domNode.querySelectorAll('.ash-composite-bar-navigation-item > button.ash-sessions-activity-item')
				.length,
			5,
		);
		assert.equal(bar.domNode.querySelectorAll('.ash-composite-bar-navigation-item.checked').length, 1);
		assert.equal(buttons[0]?.getAttribute('aria-current'), 'page');
		buttons[2]?.click();
		assert.equal(buttons[2]?.getAttribute('aria-current'), 'page');
		assert.equal(buttons[0]?.getAttribute('aria-current'), null);
		assert.equal(buttons[2]?.querySelector('.ash-icon')?.getAttribute('data-ash-icon-id'), 'projects');
		buttons[3]?.click();
		assert.equal(buttons[3]?.querySelector('.ash-icon')?.getAttribute('data-ash-icon-id'), 'artifacts');
		buttons[4]?.click();
		assert.equal(buttons[4]?.getAttribute('aria-current'), 'page');
		assert.equal(bar.domNode.querySelectorAll('.ash-composite-bar-navigation-item.checked').length, 1);
		buttons[0]?.click();
		assert.deepEqual(selectedActions, ['chat', 'projects', 'creator', 'customize', 'chat']);
		assert.equal(buttons[0]?.getAttribute('aria-current'), 'page');
		buttons[5]?.click();
		await Promise.resolve();
		assert.equal(accountAnchor, buttons[5]);
		using titlebar = registerTestComponentServices(services).createInstance(
			TitlebarPart,
			ownerDocument.body,
			'application-menu',
		);
		const renderTitlebarAccount = (visible: boolean): void =>
			titlebar.setActivityActions(visible ? [bar.accountAction] : [], (action, options) =>
				bar.createAccountActionViewItem(action, options, 'titlebar'),
			);
		for (const position of [ActivityBarPosition.TOP, ActivityBarPosition.BOTTOM]) {
			bar.setLocation(position, ownerDocument.body);
			renderTitlebarAccount(true);
			const account = titlebar.domNode.querySelector<HTMLButtonElement>(
				'[data-action-id="sessions.activity.accounts"] button',
			)!;
			assert.deepEqual(
				{
					railAccounts: bar.domNode.querySelectorAll('[data-action-id="sessions.activity.accounts"]').length,
					titlebarAccounts: titlebar.domNode.querySelectorAll('[data-action-id="sessions.activity.accounts"]')
						.length,
					menu: account.getAttribute('aria-haspopup'),
				},
				{ railAccounts: 0, titlebarAccounts: 1, menu: 'menu' },
			);
			account.click();
			assert.equal(accountAnchor, account);
		}
		const navigationHost = ownerDocument.body.appendChild(ownerDocument.createElement('div'));
		const accountHost = ownerDocument.body.appendChild(ownerDocument.createElement('div'));
		bar.domNode.querySelector<HTMLButtonElement>('button')!.focus();
		bar.setLocation(ActivityBarPosition.DEFAULT, navigationHost, accountHost);
		renderTitlebarAccount(false);
		assert.equal(navigationHost.contains(bar.domNode), true);
		assert.equal(accountHost.querySelector('button')!.classList.contains('icon-only'), false);
		assert.equal(navigationHost.querySelector('button')!.classList.contains('icon-only'), false);
		assert.equal(
			ownerDocument.activeElement,
			navigationHost.querySelector('button'),
			'Changing placement retains navigation focus',
		);
		assert.equal(navigationHost.querySelector('button')!.getAttribute('aria-current'), 'page');
		accountHost.querySelector<HTMLButtonElement>('button')!.click();
		assert.equal(accountAnchor, accountHost.querySelector('button'));
		bar.setLocation(ActivityBarPosition.HIDDEN, undefined);
		assert.equal(bar.domNode.isConnected, false);
		assert.equal(navigationHost.childElementCount, 0);
		assert.equal(accountHost.childElementCount, 0);
		bar.setLocation(ActivityBarPosition.DEFAULT, navigationHost, accountHost);
		bar.domNode.querySelectorAll<HTMLButtonElement>('button')[1]!.focus();
		const outside = ownerDocument.body.appendChild(ownerDocument.createElement('button'));
		outside.focus();
		bar.setLocation(ActivityBarPosition.TOP, navigationHost);
		bar.setLocation(ActivityBarPosition.DEFAULT, navigationHost, accountHost);
		assert.equal(ownerDocument.activeElement, outside, 'A presentation change does not steal outside focus');
		assert.equal(
			navigationHost.querySelectorAll<HTMLButtonElement>('button')[1]!.tabIndex,
			0,
			'The navigation tab stop survives while focus is elsewhere',
		);
		bar.dispose();
		assert.equal(navigationHost.childElementCount, 0, 'Disposal releases navigation from its host');
		assert.equal(accountHost.childElementCount, 0, 'Disposal releases the separately mounted Accounts entry');
	} finally {
		bar.dispose();
		configuration.dispose();
	}
});

test('Sessions Activity Bar context menu changes its own position with a fixed size', async () => {
	const ownerDocument = browser.window.document;
	ownerDocument.body.replaceChildren();
	let shownActions: readonly IAction[] = [];
	const contextMenu: IContextMenuService = {
		contextMenuStyle: 'custom' as const,
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu(delegate) {
			shownActions = delegate.getActions?.() ?? [];
		},
		hideContextMenu() {},
	};
	const configuration = new WorkbenchConfigurationService();
	using contextViews = new BrowserContextViewService(ownerDocument.body);
	using hovers = new HoverService(configuration, contextViews, contextMenu);
	using services = new InstantiationService();
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IContextMenuService, contextMenu);
	services.registerInstance(IHoverService, hovers);
	using storage = new BrowserStorageService({
		ownerWindow: browser.window as unknown as Window,
		workspaceId: 'sessions',
		flushInterval: 0,
	});
	services.registerInstance(IStorageService, storage);
	using menuServices = registerMenus(services);
	using itemMenu = MenusRegistry.appendMenuItem(Menus.ActivityBarContext, {
		command: { id: 'test.activity.context', title: 'Code action' },
		when: ActivityBarItemContext.isEqualTo('sessions.open.creator'),
	});
	const bar = registerTestComponentServices(services).createInstance(ActivityBar, ownerDocument.body, {
		async showAccountMenu() {},
	});
	try {
		bar.domNode.dispatchEvent(new browser.window.MouseEvent('contextmenu', { bubbles: true, button: 2 }));
		assert.deepEqual(
			shownActions.map(action => action.label),
			['Activity Bar Position'],
		);
		const position = shownActions[0] as import('../../../base/common/actions.js').SubmenuAction;
		assert.deepEqual(
			position.actions.map(action => [action.label, action.checked]),
			[
				['Default', true],
				['Top', false],
				['Bottom', false],
				['Hidden', false],
			],
		);
		await position.actions[1]!.run();
		assert.equal(configuration.getValue(SessionsConfiguration.activityBarLocation), ActivityBarPosition.TOP);
		assert.equal(configuration.getValue(WorkbenchConfiguration.activityBarLocation), ActivityBarPosition.DEFAULT);
		assert.equal(configuration.getValue(WorkbenchConfiguration.activityBarCompact), false);
		bar.domNode
			.querySelector('button')
			?.dispatchEvent(new browser.window.KeyboardEvent('keydown', { bubbles: true, key: 'F10', shiftKey: true }));
		assert.deepEqual(
			shownActions.map(action => action.label),
			['Move earlier', 'Move later', '', 'Activity Bar Position'],
		);
		bar.domNode
			.querySelector('[data-action-id="sessions.open.creator"] button')
			?.dispatchEvent(new browser.window.MouseEvent('contextmenu', { bubbles: true, button: 2 }));
		assert.equal(shownActions[0]!.id, 'test.activity.context');
		assert.equal(services.get(IContextKeyService).getContext().getValue(ActivityBarItemContext.key), undefined);
		bar.domNode
			.querySelector('[data-action-id="sessions.newSession"] button')
			?.dispatchEvent(new browser.window.KeyboardEvent('keydown', { bubbles: true, key: 'F10', shiftKey: true }));
		assert.equal(
			shownActions.some(action => action.id === 'test.activity.context'),
			false,
		);
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
		contextMenuStyle: 'custom' as const,
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu() {},
		hideContextMenu() {},
	});
	using storage = new BrowserStorageService({
		ownerWindow: browser.window as unknown as Window,
		workspaceId: 'sessions',
		flushInterval: 0,
	});
	services.registerInstance(IStorageService, storage);
	using menuServices = registerMenus(services);
	assert.throws(
		() =>
			registerTestComponentServices(services).createInstance(ActivityBar, browser.window.document.body, {
				showAccountMenu() {},
			}),
		/hoverService/,
	);
});

test('navigation order survives a new window and includes new menu contributions', async () => {
	using configuration = new WorkbenchConfigurationService();
	using contextViews = new BrowserContextViewService(document.body);
	let shownActions: readonly IAction[] = [];
	const contextMenu: IContextMenuService = {
		contextMenuStyle: 'custom' as const,
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu(delegate) {
			shownActions = delegate.getActions!();
		},
		hideContextMenu() {},
	};
	using hovers = new HoverService(configuration, contextViews, contextMenu);
	using services = new InstantiationService();
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IContextMenuService, contextMenu);
	services.registerInstance(IHoverService, hovers);
	using storage = new BrowserStorageService({
		ownerWindow: browser.window as unknown as Window,
		workspaceId: 'sessions',
		flushInterval: 0,
	});
	services.registerInstance(IStorageService, storage);
	using menuServices = registerMenus(services);
	storage.store(
		'sessions.activityBar.actionOrder',
		JSON.stringify([
			'sessions.open.chat',
			'sessions.newSession',
			'sessions.open.teams',
			'sessions.open.projects',
			'sessions.open.code',
			'sessions.open.design',
		]),
		StorageScope.PROFILE,
		StorageTarget.USER,
	);
	using bar = registerTestComponentServices(services).createInstance(ActivityBar, document.body, {
		showAccountMenu() {},
	});
	assert.equal(
		storage.get('sessions.activityBar.actionOrder', StorageScope.PROFILE),
		JSON.stringify(['sessions.newSession', 'sessions.search', 'sessions.open.projects', 'sessions.open.creator']),
	);
	setARIAContainer(document.body);
	const buttons = [...bar.domNode.querySelectorAll<HTMLButtonElement>('button')];
	buttons[3]!.dispatchEvent(
		new browser.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }),
	);
	await shownActions[0]!.run();
	assert.equal(bar.domNode.querySelectorAll('button')[2], buttons[3]);
	await storage.flush();
	using restored = registerTestComponentServices(services).createInstance(ActivityBar, document.body, {
		showAccountMenu() {},
	});
	assert.deepEqual(
		[...restored.domNode.querySelectorAll('button')].slice(0, 5).map(button => button.textContent),
		['New', 'Search', 'Artifacts', 'Projects', 'Customize'],
	);
	using contribution = MenusRegistry.appendMenuItem(Menus.ActivityBar, {
		command: { id: 'test.activity', title: 'Test action', icon: Lxicon.chat2 },
		order: 60,
	});
	assert.deepEqual(
		[...restored.domNode.querySelectorAll('button')].map(button => button.textContent),
		['New', 'Search', 'Artifacts', 'Projects', 'Customize', 'Test action', 'Accounts'],
	);
	assert.equal(restored.domNode.querySelector('button')!.getAttribute('aria-current'), 'page');
});

test('navigation and ordering labels use the Chinese language catalog', async () => {
	const { setNlsResolver, resetNlsResolver, formatNlsMessage } = await import('../../../nls.js');
	const { productLanguagePackCatalogs } =
		await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const catalog = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, message, parameters) =>
		formatNlsMessage(catalog.bundles[bundle]?.[key] ?? message, parameters),
	);
	try {
		const ownerDocument = browser.window.document;
		ownerDocument.body.replaceChildren();
		using configuration = new WorkbenchConfigurationService();
		using contextViews = new BrowserContextViewService(ownerDocument.body);
		let actions: readonly IAction[] = [];
		const menus: IContextMenuService = {
			contextMenuStyle: 'custom' as const,
			onDidShowContextMenu: Event.None,
			onDidHideContextMenu: Event.None,
			showContextMenu(delegate) {
				actions = delegate.getActions!();
			},
			hideContextMenu() {},
		};
		using hovers = new HoverService(configuration, contextViews, menus);
		using services = new InstantiationService();
		services.registerInstance(IConfigurationService, configuration);
		services.registerInstance(IContextMenuService, menus);
		services.registerInstance(IHoverService, hovers);
		using storage = new BrowserStorageService({
			ownerWindow: browser.window as unknown as Window,
			workspaceId: 'sessions',
			flushInterval: 0,
		});
		services.registerInstance(IStorageService, storage);
		using menuServices = registerMenus(services);
		using bar = registerTestComponentServices(services).createInstance(ActivityBar, ownerDocument.body, {
			showAccountMenu() {},
		});
		const buttons = [...bar.domNode.querySelectorAll('button')];
		buttons[1]!.dispatchEvent(
			new browser.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }),
		);
		assert.deepEqual(
			{
				navigation: bar.domNode.querySelector('.ash-sessions-navigation')!.getAttribute('aria-label'),
				moves: actions.slice(0, 2).map(action => action.label),
			},
			{ navigation: '导航', moves: ['向前移动', '向后移动'] },
		);
	} finally {
		resetNlsResolver();
	}
});

test('Code navigation has its own actions and order while Chat keeps its saved navigation', async () => {
	const document = browser.window.document;
	document.body.replaceChildren();
	using configuration = new WorkbenchConfigurationService();
	using views = new BrowserContextViewService(document.body);
	let shown: readonly IAction[] = [];
	const contextMenus: IContextMenuService = {
		contextMenuStyle: 'custom',
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu(delegate) {
			shown = delegate.getActions!();
		},
		hideContextMenu() {},
	};
	using hovers = new HoverService(configuration, views, contextMenus);
	using services = new InstantiationService();
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IContextMenuService, contextMenus);
	services.registerInstance(IHoverService, hovers);
	using storage = new BrowserStorageService({
		ownerWindow: browser.window as unknown as Window,
		workspaceId: 'navigation',
		flushInterval: 0,
	});
	services.registerInstance(IStorageService, storage);
	using menus = registerMenus(services);
	const contexts = services.get(IContextKeyService);
	contexts.setContext('sessions.automationsAvailable', true);
	const chatOrder = ['sessions.open.creator', 'sessions.newSession', 'sessions.search', 'sessions.open.projects'];
	storage.store(
		'sessions.activityBar.actionOrder',
		JSON.stringify(chatOrder.filter(id => id !== 'sessions.search')),
		StorageScope.PROFILE,
		StorageTarget.USER,
	);
	using bar = registerTestComponentServices(services).createInstance(ActivityBar, document.body, {
		showAccountMenu() {},
	});
	const labels = () =>
		[...bar.domNode.querySelectorAll('.ash-sessions-navigation button')].map(button => button.textContent);
	assert.deepEqual(labels(), ['Artifacts', 'New', 'Search', 'Projects', 'Customize']);
	contexts.setContext('sessions.workspaceMode', 'code');
	assert.deepEqual(labels(), ['New', 'Search', 'Automations', 'Collab', 'Agent Teams', 'Symphony', 'Customize']);
	assert.equal(bar.domNode.querySelector('[data-action-id="sessions.open.code"]'), null);
	setARIAContainer(document.body);
	bar.domNode
		.querySelector('[data-action-id="sessions.open.collaboration"] button')!
		.dispatchEvent(new browser.window.KeyboardEvent('keydown', { bubbles: true, key: 'F10', shiftKey: true }));
	await shown[0]!.run();
	assert.deepEqual(labels(), ['New', 'Search', 'Collab', 'Automations', 'Agent Teams', 'Symphony', 'Customize']);
	assert.equal(storage.get('sessions.activityBar.actionOrder', StorageScope.PROFILE), JSON.stringify(chatOrder));
	contexts.setContext('sessions.workspaceMode', 'chat');
	assert.deepEqual(labels(), ['Artifacts', 'New', 'Search', 'Projects', 'Customize']);
	contexts.setContext('sessions.workspaceMode', 'code');
	assert.deepEqual(labels(), ['New', 'Search', 'Collab', 'Automations', 'Agent Teams', 'Symphony', 'Customize']);
});

test('workspace mode controls switch retained pages and follow their owner selection', async () => {
	const { WindowModeControl } = await import('../../browser/parts/titlebar/windowModeControl.js');
	const { observableValue } = await import('../../../base/common/observable.js');
	const ownerDocument = browser.window.document;
	ownerDocument.body.replaceChildren();
	using configuration = new WorkbenchConfigurationService();
	using views = new BrowserContextViewService(ownerDocument.body);
	const contextMenus: IContextMenuService = {
		contextMenuStyle: 'custom',
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu() {},
		hideContextMenu() {},
	};
	using hovers = new HoverService(configuration, views, contextMenus);
	using services = new InstantiationService();
	using commands = new CommandService(services);
	services.registerInstance(ICommandService, commands);
	services.registerInstance(IHoverService, hovers);
	const active = observableValue<'agents' | 'code'>('test mode', 'agents');
	const opened: string[] = [];
	using codeCommand = CommandsRegistry.register('sessions.open.code', () => {
		opened.push('code');
		active.set('code');
	});
	using chatCommand = CommandsRegistry.register('sessions.open.chat', () => {
		opened.push('agents');
		active.set('agents');
	});
	using control = services.createInstance(WindowModeControl, ownerDocument.body, active, {
		agents: 'sessions.open.chat',
		code: 'sessions.open.code',
	});
	const buttons = [
		...ownerDocument.querySelectorAll<HTMLButtonElement>('.ash-window-mode-control .ash-segmented-control-option'),
	];
	assert.equal(buttons[0]!.querySelector('.ash-icon')?.getAttribute('data-ash-icon-id'), 'chat-1');
	buttons[0]!.click();
	assert.deepEqual(opened, ['agents']);
	buttons[1]!.click();
	assert.deepEqual(
		buttons.map(button => button.getAttribute('aria-pressed')),
		['false', 'true'],
	);
	buttons[1]!.click();
	assert.deepEqual(opened, ['agents', 'code', 'code']);
	buttons[0]!.click();
	assert.deepEqual(opened, ['agents', 'code', 'code', 'agents']);
	assert.deepEqual(
		buttons.map(button => button.getAttribute('aria-pressed')),
		['true', 'false'],
	);
	active.set('code');
	assert.deepEqual(
		buttons.map(button => button.getAttribute('aria-pressed')),
		['false', 'true'],
	);
	control.dispose();
	assert.equal(ownerDocument.querySelector('.ash-window-mode-control'), null);
});

function registerMenus(services: InstanceType<typeof InstantiationService>): InstanceType<typeof DisposableStore> {
	const resources = new DisposableStore();
	const contexts = resources.add(new ContextKeyService());
	services.registerInstance(IContextKeyService, contexts);
	const registry = new CommandRegistry();
	const commands = resources.add(new CommandService(services, registry));
	services.registerInstance(ICommandService, commands);
	services.registerInstance(IMenuService, services.createInstance(MenuService));
	const keys = new Map(
		['chat', 'collaboration', 'teams', 'projects', 'code', 'creator', 'symphony', 'customize'].map(id => [
			id,
			contexts.createKey<boolean>(`sessions.activity.${id}Selected`, id === 'chat'),
		]),
	);
	const select = (id: string): void =>
		contexts.bufferChangeEvents(() => {
			contexts.setContext(
				'sessions.workspaceMode',
				['code', 'collaboration', 'teams', 'symphony'].includes(id) ? 'code' : 'chat',
			);
			for (const [candidate, key] of keys) {
				key.set(candidate === id);
			}
		});
	services.registerInstance(ISessionsLayoutService, {
		openEntry: async (entry: { id: string }) => select(entry.id),
	} as unknown as import('../../services/layout/common/sessionsLayoutService.js').ISessionsLayoutService);
	resources.add(
		registry.register('sessions.open.customize', CommandsRegistry.getCommand('sessions.open.customize')!),
	);
	resources.add(
		registry.register('sessions.newSession', () =>
			select(contexts.getValue('sessions.workspaceMode') === 'code' ? 'code' : 'chat'),
		),
	);
	for (const id of ['chat', 'collaboration', 'teams', 'code', 'symphony']) {
		resources.add(registry.register(`sessions.open.${id}`, () => select(id)));
	}
	for (const id of ['projects', 'creator']) {
		resources.add(registry.register(`sessions.open.${id}`, CommandsRegistry.getCommand(`sessions.open.${id}`)!));
		resources.add(registry.register(`sessions.show.${id}`, () => select(id)));
	}
	services.registerInstance(IEditorService, {
		openEditor: async (input: { resource: { scheme: string } }) =>
			select(input.resource.scheme === 'ash-projects' ? 'projects' : 'creator'),
	} as unknown as import('../../../workbench/services/editor/common/editorService.js').IEditorService);
	services.registerInstance(IDesignEditorService, {
		input: { resource: URI.parse('ash-design:/canvas') },
	} as unknown as import('../../contrib/creator/browser/designEditorService.js').IDesignEditorService);
	return resources;
}
