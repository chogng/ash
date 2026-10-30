import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { IContextMenuDelegate } from '../../../../../base/browser/contextmenu.js';
import type { IAction } from '../../../../../base/common/actions.js';
import type { IAccountService, AccountState } from '../../../../../platform/accounts/common/accountService.js';
import type { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ILogService, LogEntry } from '../../../../../platform/log/common/log.js';
import type { ISecretStorageStatusService } from '../../../../../platform/secrets/common/secrets.js';
import type { NotificationItem } from '../../../../common/notifications.js';
import type { ILocalizationService } from '../../../../services/localization/common/localizationService.js';
import type { SideBarLocation } from '../../../../common/configuration.js';

const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
for (const [name, value] of Object.entries({ window: browser.window, document: browser.window.document, Node: browser.window.Node, Element: browser.window.Element, HTMLElement: browser.window.HTMLElement, Event: browser.window.Event, MouseEvent: browser.window.MouseEvent })) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { DisposableStore, toDisposable } = await import('../../../../../base/common/lifecycle.js');
const { SubmenuAction } = await import('../../../../../base/common/actions.js');
const { formatNlsMessage, setNlsMessages } = await import('../../../../../nls.js');
const { Emitter, Event } = await import('../../../../../base/common/event.js');
const { IAccountService: AccountServiceId } = await import('../../../../../platform/accounts/common/accountService.js');
const { IContextMenuService: ContextMenuServiceId } = await import('../../../../../platform/contextview/browser/contextView.js');
const { IConfigurationService: ConfigurationServiceId } = await import('../../../../../platform/configuration/common/configuration.js');
const { AnchorAlignment, AnchorAxisAlignment } = await import('../../../../../base/browser/ui/contextview/contextview.js');
const { ILogService: LogServiceId } = await import('../../../../../platform/log/common/log.js');
const { LogService } = await import('../../../../../platform/log/common/logServiceImpl.js');
const { ISecretStorageStatusService: SecretStorageStatusServiceId, secretStorageStateMessage } = await import('../../../../../platform/secrets/common/secrets.js');
const { ILifecycleService, LifecyclePhase } = await import('../../../../services/lifecycle/common/lifecycle.js');
const { AbstractLifecycleService } = await import('../../../../services/lifecycle/common/lifecycleService.js');
const { INotificationService } = await import('../../../../../platform/notification/common/notification.js');
const { NotificationService } = await import('../../../../services/notification/common/notificationService.js');
const { DeferredPromise } = await import('../../../../../base/common/async.js');
const { productLanguagePackCatalogs } = await import('../../../../services/localization/common/localizationCatalogs.js');
const { IStorageService: StorageServiceId } = await import('../../../../../platform/storage/common/storage.js');
const { BrowserStorageService } = await import('../../../../services/storage/browser/storageService.js');
const { ILocalizationService: LocalizationServiceId } = await import('../../../../services/localization/common/localizationService.js');
const { IGitHubConnectionService: GitHubConnectionServiceId } = await import('../../../../services/accounts/common/gitHubConnectionService.js');
const { IMenuService, MenuId, MenusRegistry } = await import('../../../../../platform/actions/common/actions.js');
const { MenuService } = await import('../../../../../platform/actions/common/menuService.js');
const { ICommandService, CommandsRegistry } = await import('../../../../../platform/commands/common/commands.js');
const { ContextKeyService } = await import('../../../../../platform/contextkey/browser/contextKeyService.js');
const { InstantiationService } = await import('../../../../../platform/instantiation/common/instantiationService.js');
const { CommandService } = await import('../../../../services/commands/common/commandService.js');
const { GlobalCompositeBar } = await import('../../globalCompositeBar.js');
const { IRendererHostService } = await import('../../../../../platform/renderer/common/rendererHost.js');
const { createDisconnectedRendererApi } = await import('../../../rendererApi.js');

class TestLifecycleService extends AbstractLifecycleService { }

function controlledIdle(disposables: InstanceType<typeof DisposableStore>) {
	const ownerWindow = browser.window;
	const request = Object.getOwnPropertyDescriptor(ownerWindow, 'requestIdleCallback');
	const cancel = Object.getOwnPropertyDescriptor(ownerWindow, 'cancelIdleCallback');
	let idle: IdleRequestCallback | undefined;
	Object.defineProperty(ownerWindow, 'requestIdleCallback', { configurable: true, value: (callback: IdleRequestCallback) => { idle = callback; return 1; } });
	Object.defineProperty(ownerWindow, 'cancelIdleCallback', { configurable: true, value: () => { idle = undefined; } });
	disposables.add(toDisposable(() => {
		if (request) Object.defineProperty(ownerWindow, 'requestIdleCallback', request); else Reflect.deleteProperty(ownerWindow, 'requestIdleCallback');
		if (cancel) Object.defineProperty(ownerWindow, 'cancelIdleCallback', cancel); else Reflect.deleteProperty(ownerWindow, 'cancelIdleCallback');
	}));
	return { run: () => { const callback = idle; idle = undefined; callback?.({ didTimeout: false, timeRemaining: () => 50 }); }, pending: () => !!idle };
}

test('Activity Bar global actions open account and management menus', async () => {
	using disposables = new DisposableStore();
	const idle = controlledIdle(disposables);
	const ownerDocument = browser.window.document;
	ownerDocument.body.replaceChildren();
	const services = disposables.add(new InstantiationService());
	services.registerInstance(IRendererHostService, { ...createDisconnectedRendererApi(), hasAppServer: true });
	const commands = disposables.add(new CommandService(services));
	services.registerInstance(ICommandService, commands);
	const contextKeys = disposables.add(new ContextKeyService());
	const menus = new MenuService(commands, contextKeys);
	services.registerInstance(IMenuService, menus);
	let actions: readonly IAction[] = [];
	let closeMenu: (didCancel: boolean) => void = () => { };
	let placement: Pick<IContextMenuDelegate, 'anchorAlignment' | 'anchorAxisAlignment'> = {};
	let sideBarLocation: SideBarLocation = 'left';
	const contextMenu: IContextMenuService = {
		contextMenuStyle: 'custom' as const,
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu(options) {
			actions = options.getActions?.() ?? [];
			placement = { anchorAlignment: options.anchorAlignment, anchorAxisAlignment: options.anchorAxisAlignment };
			closeMenu = options.onHide ?? (() => { });
		},
		hideContextMenu() { },
	};
	services.registerInstance(ContextMenuServiceId, contextMenu);
	services.registerInstance(ConfigurationServiceId, { getValue: () => sideBarLocation } as unknown as IConfigurationService);
	const accountsChanged = disposables.add(new Emitter<AccountState>());
	let accountState: AccountState = {
		revision: 1n, accounts: [
			{ provider: 'chatgpt-subscription', accountId: 'one', email: 'lanxiang484@gmail.com', status: 'ready', credentialRevision: 1n },
			{ provider: 'github', accountId: 'octocat', displayName: 'octocat', status: 'ready', credentialRevision: 1n },
		]
	};
	const loggedOutProviders: string[] = [];
	const accountService: IAccountService = {
		onDidChangeAccounts: accountsChanged.event,
		onDidCompleteLogin: Event.None,
		read: async () => accountState,
		startLogin: async () => ({ type: 'connected', loginId: 'one' }),
		cancelLogin: async () => { },
		logout: async provider => { loggedOutProviders.push(provider); },
	};
	services.registerInstance(AccountServiceId, accountService);
	services.registerInstance(SecretStorageStatusServiceId, {
		readState: async () => ({ status: 'available' }),
		authorizeAccess: async () => { throw new Error('Unexpected authorization'); },
		setStorageMode: async () => { throw new Error('Unexpected storage migration'); },
	});
	const githubActions: string[] = [];
	const githubConnection = {
		isConnecting: false,
		connect: async () => { githubActions.push('connect'); githubConnection.isConnecting = true; },
		cancel: async () => { githubActions.push('cancel'); githubConnection.isConnecting = false; },
	};
	services.registerInstance(GitHubConnectionServiceId, githubConnection);
	const localizationChanged = disposables.add(new Emitter<void>());
	let manageLabel = 'Manage';
	const localization: ILocalizationService = {
		whenReady: Promise.resolve(),
		translate: (_bundle, key, fallback, parameters) => key === 'workbench.manage' ? manageLabel : formatNlsMessage(fallback, parameters),
	};
	services.registerInstance(LocalizationServiceId, localization);
	const logService: ILogService = { trace() { }, debug() { }, info() { }, warn() { }, error() { } };
	services.registerInstance(LogServiceId, logService);
	const storage = disposables.add(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'test', backend: browser.window.localStorage, flushInterval: 0 }));
	services.registerInstance(StorageServiceId, storage);
	const lifecycle = disposables.add(new TestLifecycleService(undefined, logService, storage));
	lifecycle.phase = LifecyclePhase.Restored;
	services.registerInstance(ILifecycleService, lifecycle);
	services.registerInstance(INotificationService, disposables.add(new NotificationService(storage)));
	let settingsOpened = false;
	let manageAccountsOpened = 0;
	disposables.add(CommandsRegistry.register('test.activityBar.settings', () => { settingsOpened = true; }));
	disposables.add(CommandsRegistry.register('workbench.action.manageAccounts', () => { manageAccountsOpened++; }));
	disposables.add(MenusRegistry.appendMenuItem(MenuId.GlobalActivity, { command: { id: 'test.activityBar.settings', title: 'Settings' }, group: '2_configuration' }));
	const bar = disposables.add(services.createInstance(GlobalCompositeBar, ownerDocument.body));
	await Promise.resolve();
	idle.run();
	await Promise.resolve();
	const accountsButton = bar.domNode.querySelector<HTMLButtonElement>('[data-action-id="ash.activityBar.accounts"] button');
	const manageButton = bar.domNode.querySelector<HTMLButtonElement>('[data-action-id="ash.activityBar.manage"] button');
	assert.ok(accountsButton);
	assert.ok(manageButton);
	accountsButton.click();
	assert.deepEqual(placement, { anchorAlignment: AnchorAlignment.Right, anchorAxisAlignment: AnchorAxisAlignment.Horizontal });
	assert.deepEqual(actions.map(action => action.label), ['lanxiang484@gmail.com (ChatGPT)', 'octocat (GitHub)', '', 'Manage Accounts']);
	assert.ok(actions[0] instanceof SubmenuAction);
	assert.ok(actions[1] instanceof SubmenuAction);
	assert.deepEqual(actions[0].actions.map(action => action.label), ['Sign Out']);
	await actions[1].actions[0]?.run();
	await actions[3]?.run();
	assert.deepEqual({ loggedOutProviders, manageAccountsOpened }, { loggedOutProviders: ['github'], manageAccountsOpened: 1 });
	accountState = { revision: 2n, accounts: [{ provider: 'chatgpt-web', accountId: 'private', status: 'ready', credentialRevision: 1n }] };
	accountsChanged.fire(accountState);
	closeMenu(false);
	accountsButton.click();
	assert.equal(actions[0]?.label, 'ChatGPT Web (ChatGPT Web)');
	assert.ok(actions[0] instanceof SubmenuAction);
	await actions[0].actions[0]?.run();
	assert.deepEqual(loggedOutProviders, ['github', 'chatgpt-web']);
	accountState = { revision: 3n, accounts: [] };
	accountsChanged.fire(accountState);
	closeMenu(false);
	accountsButton.click();
	assert.deepEqual(actions.map(action => action.label), ['Manage Accounts', 'Connect GitHub']);
	await actions[0]?.run();
	assert.equal(manageAccountsOpened, 2);
	await actions[1]?.run();
	closeMenu(false);
	accountsButton.click();
	assert.deepEqual(actions.map(action => action.label), ['Manage Accounts', 'Cancel GitHub connection']);
	await actions[1]?.run();
	assert.deepEqual(githubActions, ['connect', 'cancel']);
	closeMenu(false);
	manageButton.click();
	assert.deepEqual(placement, { anchorAlignment: AnchorAlignment.Right, anchorAxisAlignment: AnchorAxisAlignment.Horizontal });
	assert.equal(actions.find(action => action.id === 'test.activityBar.settings')?.label, 'Settings');
	await actions.find(action => action.id === 'test.activityBar.settings')?.run();
	assert.equal(settingsOpened, true);
	closeMenu(false);
	sideBarLocation = 'right';
	manageButton.click();
	assert.deepEqual(placement, { anchorAlignment: AnchorAlignment.Left, anchorAxisAlignment: AnchorAxisAlignment.Horizontal });
	closeMenu(false);
	const titlebarContainer = ownerDocument.createElement('div');
	ownerDocument.body.append(titlebarContainer);
	disposables.add(toDisposable(() => titlebarContainer.remove()));
	const titlebarManage = bar.getActions().find(action => action.id === 'ash.activityBar.manage');
	assert.ok(titlebarManage);
	const titlebarViewItem = bar.createActionViewItem(titlebarManage, {});
	assert.ok(titlebarViewItem);
	disposables.add(titlebarViewItem);
	titlebarViewItem.render(titlebarContainer);
	titlebarContainer.querySelector<HTMLButtonElement>('button')?.click();
	assert.deepEqual(placement, { anchorAlignment: AnchorAlignment.Left, anchorAxisAlignment: AnchorAxisAlignment.Vertical });
	closeMenu(false);
	manageLabel = '管理';
	localizationChanged.fire();
	assert.equal(bar.domNode.querySelector<HTMLButtonElement>('[data-action-id="ash.activityBar.manage"] button')?.getAttribute('aria-label'), 'Manage');
	const toggleAccounts = bar.getContextMenuActions()[0];
	assert.equal(toggleAccounts?.checked, true);
	toggleAccounts?.run();
	assert.equal(bar.domNode.querySelector('[data-action-id="ash.activityBar.accounts"]'), null);
	assert.equal(bar.getContextMenuActions()[0]?.checked, false);
	toggleAccounts?.run();
	assert.ok(bar.domNode.querySelector('[data-action-id="ash.activityBar.accounts"]'));
});

function accountReadServices(disposables: InstanceType<typeof DisposableStore>, readState: ISecretStorageStatusService['readState'] | undefined, log: ILogService) {
	const services = disposables.add(new InstantiationService());
	const idle = controlledIdle(disposables);
	services.registerInstance(IRendererHostService, { ...createDisconnectedRendererApi(), hasAppServer: true });
	const commands = disposables.add(new CommandService(services));
	services.registerInstance(ICommandService, commands);
	const contextKeys = disposables.add(new ContextKeyService());
	services.registerInstance(IMenuService, new MenuService(commands, contextKeys));
	services.registerInstance(ContextMenuServiceId, { contextMenuStyle: 'custom', onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu() { }, hideContextMenu() { } });
	services.registerInstance(ConfigurationServiceId, { getValue: () => 'left' } as unknown as IConfigurationService);
	const failure = new Error('AccountUnavailable');
	const unexpected = async (): Promise<never> => { throw new Error('Unexpected account or storage mutation'); };
	const changes = disposables.add(new Emitter<AccountState>());
	let reads = 0;
	const accounts: IAccountService = { onDidChangeAccounts: changes.event, onDidCompleteLogin: Event.None, read: async () => { reads++; throw failure; }, startLogin: unexpected, cancelLogin: unexpected, logout: unexpected };
	services.registerInstance(AccountServiceId, accounts);
	services.registerInstance(GitHubConnectionServiceId, { isConnecting: false, connect: unexpected, cancel: unexpected });
	services.registerInstance(LocalizationServiceId, { whenReady: Promise.resolve(), translate: (_bundle, _key, fallback, parameters) => formatNlsMessage(fallback, parameters) });
	services.registerInstance(LogServiceId, log);
	const storage = disposables.add(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'account-read-failure', backend: browser.window.localStorage, flushInterval: 0 }));
	services.registerInstance(StorageServiceId, storage);
	const lifecycle = disposables.add(new TestLifecycleService(undefined, log, storage));
	services.registerInstance(ILifecycleService, lifecycle);
	const notifications = disposables.add(new NotificationService(storage));
	services.registerInstance(INotificationService, notifications);
	if (readState) services.registerInstance(SecretStorageStatusServiceId, { readState, authorizeAccess: unexpected, setStorageMode: unexpected });
	return {
		services, failure, accounts, changes, lifecycle, notifications, idle, reads: () => reads,
		async restore() { lifecycle.phase = LifecyclePhase.Restored; await Promise.resolve(); idle.run(); }
	};
}

for (const locale of ['en', 'zh-CN']) test(`Ephemeral credential storage shows one actionable recovery notification (${locale})`, async () => {
	using disposables = new DisposableStore();
	const catalog = productLanguagePackCatalogs.find(catalog => catalog.locale === locale);
	setNlsMessages(locale, catalog?.bundles ?? {});
	try {
		const state = { status: 'accessDenied', mode: 'encrypted', storageType: 'in-memory' } as const;
		const log = disposables.add(new LogService());
		const f = accountReadServices(disposables, async () => state, log);
		f.accounts.read = async () => ({ revision: 1n, accounts: [] });
		const added = new DeferredPromise<NotificationItem>();
		let count = 0;
		disposables.add(f.notifications.model.onDidAdd(item => { count++; added.complete(item); }));
		let opened: unknown;
		disposables.add(CommandsRegistry.register('workbench.action.openSettings', (_accessor, options) => { opened = options; }));
		disposables.add(f.services.createInstance(GlobalCompositeBar, browser.window.document.body));
		await f.restore();
		const item = await added.p;
		assert.equal(item.message, secretStorageStateMessage(state));
		assert.match(item.message, locale === 'en' ? /lost when Ash exits/ : /退出 Ash/);
		await item.actions?.primary?.[0]?.run();
		assert.deepEqual(opened, { section: 'models' });
		f.changes.fire({ revision: 2n, accounts: [] });
		await Promise.resolve();
		assert.equal(count, 1);
	} finally { setNlsMessages('en', {}); }
});

test('Account initialization waits for restoration and an idle period, retaining its original failure', async () => {
	using disposables = new DisposableStore();
	const entries: LogEntry[] = [];
	const logged = new DeferredPromise<void>();
	const log = disposables.add(new LogService({ sinks: [{ log: entry => { entries.push(entry); logged.complete(); } }] }));
	const f = accountReadServices(disposables, async () => ({ status: 'available' }), log);
	disposables.add(f.services.createInstance(GlobalCompositeBar, browser.window.document.body));
	await Promise.resolve();
	assert.equal(f.reads(), 0);
	assert.equal(f.idle.pending(), false);
	f.lifecycle.phase = LifecyclePhase.Restored;
	await Promise.resolve();
	assert.equal(f.reads(), 0);
	assert.equal(f.idle.pending(), true);
	f.idle.run();
	await logged.p;
	assert.equal(f.reads(), 1);
	assert.equal(entries[0]?.message, 'Could not read accounts AccountUnavailable');
	assert.equal(entries[0]?.error, f.failure);
});

test('Account initialization cancels pending idle work when its owner closes', async () => {
	using disposables = new DisposableStore();
	const log = disposables.add(new LogService());
	const f = accountReadServices(disposables, async () => ({ status: 'available' }), log);
	const bar = disposables.add(f.services.createInstance(GlobalCompositeBar, browser.window.document.body));
	f.lifecycle.phase = LifecyclePhase.Restored;
	await Promise.resolve();
	assert.equal(f.idle.pending(), true);
	bar.dispose();
	assert.equal(f.idle.pending(), false);
	f.idle.run();
	assert.equal(f.reads(), 0);
});

test('Account diagnostics require the registered storage owner', () => {
	using disposables = new DisposableStore();
	const log = disposables.add(new LogService());
	const { services } = accountReadServices(disposables, undefined, log);
	assert.throws(() => services.createInstance(GlobalCompositeBar, browser.window.document.body), /secretStorageStatusService/);
});

test('Late storage observations do not notify after the window owner closes', async () => {
	using disposables = new DisposableStore();
	const entered = new DeferredPromise<void>();
	const health = new DeferredPromise<Awaited<ReturnType<ISecretStorageStatusService['readState']>>>();
	const log = disposables.add(new LogService());
	const f = accountReadServices(disposables, () => { entered.complete(); return health.p; }, log);
	f.accounts.read = async () => ({ revision: 1n, accounts: [] });
	let count = 0;
	disposables.add(f.notifications.model.onDidAdd(() => count++));
	const bar = disposables.add(f.services.createInstance(GlobalCompositeBar, browser.window.document.body));
	await f.restore();
	await entered.p;
	bar.dispose();
	health.complete({ status: 'accessDenied', storageType: 'in-memory' });
	await health.p;
	assert.equal(count, 0);
});
