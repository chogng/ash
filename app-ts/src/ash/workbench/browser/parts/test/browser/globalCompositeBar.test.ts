import { h as createDomElement } from '../../../../../base/browser/dom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { IContextMenuDelegate } from '../../../../../base/browser/contextmenu.js';
import type { IAction } from '../../../../../base/common/actions.js';
import type { IAccountService, AccountState } from '../../../../../platform/accounts/common/accountService.js';
import type { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ILogService } from '../../../../../platform/log/common/log.js';
import type { ILocalizationService } from '../../../../services/localization/common/localizationService.js';
import type { SideBarLocation } from '../../../../common/configuration.js';

const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
for (const [name, value] of Object.entries({ window: browser.window, document: browser.window.document, Node: browser.window.Node, Element: browser.window.Element, HTMLElement: browser.window.HTMLElement, Event: browser.window.Event, MouseEvent: browser.window.MouseEvent })) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { DisposableStore, toDisposable } = await import('../../../../../base/common/lifecycle.js');
const { SubmenuAction } = await import('../../../../../base/common/actions.js');
const { formatNlsMessage } = await import('../../../../../nls.js');
const { Emitter, Event } = await import('../../../../../base/common/event.js');
const { IAccountService: AccountServiceId } = await import('../../../../../platform/accounts/common/accountService.js');
const { IContextMenuService: ContextMenuServiceId } = await import('../../../../../platform/contextview/browser/contextView.js');
const { IConfigurationService: ConfigurationServiceId } = await import('../../../../../platform/configuration/common/configuration.js');
const { AnchorAlignment, AnchorAxisAlignment } = await import('../../../../../base/browser/ui/contextview/contextview.js');
const { ILogService: LogServiceId } = await import('../../../../../platform/log/common/log.js');
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

test('Activity Bar global actions open account and management menus', async () => {
	using disposables = new DisposableStore();
	const ownerDocument = browser.window.document;
	ownerDocument.body.replaceChildren();
	const services = disposables.add(new InstantiationService());
	const commands = disposables.add(new CommandService(services));
	services.registerInstance(ICommandService, commands);
	const contextKeys = disposables.add(new ContextKeyService());
	const menus = new MenuService(commands, contextKeys);
	services.registerInstance(IMenuService, menus);
	let actions: readonly IAction[] = [];
	let closeMenu: (didCancel: boolean) => void = () => {};
	let placement: Pick<IContextMenuDelegate, 'anchorAlignment' | 'anchorAxisAlignment'> = {};
	let sideBarLocation: SideBarLocation = 'left';
	const contextMenu: IContextMenuService = {
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu(options) {
			actions = options.getActions?.() ?? [];
			placement = { anchorAlignment: options.anchorAlignment, anchorAxisAlignment: options.anchorAxisAlignment };
			closeMenu = options.onHide ?? (() => {});
		},
		hideContextMenu() {},
	};
	services.registerInstance(ContextMenuServiceId, contextMenu);
	services.registerInstance(ConfigurationServiceId, { getValue: () => sideBarLocation } as unknown as IConfigurationService);
	const accountsChanged = disposables.add(new Emitter<AccountState>());
	let accountState: AccountState = { revision: 1n, accounts: [
		{ provider: 'chatgpt-subscription', accountId: 'one', email: 'lanxiang484@gmail.com', status: 'ready', credentialRevision: 1n },
		{ provider: 'github', accountId: 'octocat', displayName: 'octocat', status: 'ready', credentialRevision: 1n },
	] };
	const loggedOutProviders: string[] = [];
	const accountService: IAccountService = {
		onDidChangeAccounts: accountsChanged.event,
		onDidCompleteLogin: Event.None,
		read: async () => accountState,
		startLogin: async () => ({ type: 'connected', loginId: 'one' }),
		cancelLogin: async () => {},
		logout: async provider => { loggedOutProviders.push(provider); },
	};
	services.registerInstance(AccountServiceId, accountService);
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
		onDidChange: localizationChanged.event,
		whenReady: Promise.resolve(),
		translate: (_bundle, key, fallback, parameters) => key === 'workbench.manage' ? manageLabel : formatNlsMessage(fallback, parameters),
	};
	services.registerInstance(LocalizationServiceId, localization);
	const logService: ILogService = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
	services.registerInstance(LogServiceId, logService);
	const storage = disposables.add(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, applicationId: 'code', workspaceId: 'test', backend: browser.window.localStorage, flushInterval: 0 }));
	services.registerInstance(StorageServiceId, storage);
	let settingsOpened = false;
	let manageAccountsOpened = 0;
	disposables.add(CommandsRegistry.register('test.activityBar.settings', () => { settingsOpened = true; }));
	disposables.add(CommandsRegistry.register('workbench.action.manageAccounts', () => { manageAccountsOpened++; }));
	disposables.add(MenusRegistry.appendMenuItem(MenuId.GlobalActivity, { command: { id: 'test.activityBar.settings', title: 'Settings' }, group: '2_configuration' }));
	const bar = disposables.add(services.createInstance(GlobalCompositeBar, ownerDocument.body));
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
	accountState = { revision: 2n, accounts: [] };
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
	const titlebarContainer = createDomElement(ownerDocument, 'div');
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
	assert.equal(bar.domNode.querySelector<HTMLButtonElement>('[data-action-id="ash.activityBar.manage"] button')?.getAttribute('aria-label'), '管理');
	const toggleAccounts = bar.getContextMenuActions()[0];
	assert.equal(toggleAccounts?.checked, true);
	toggleAccounts?.run();
	assert.equal(bar.domNode.querySelector('[data-action-id="ash.activityBar.accounts"]'), null);
	assert.equal(bar.getContextMenuActions()[0]?.checked, false);
	toggleAccounts?.run();
	assert.ok(bar.domNode.querySelector('[data-action-id="ash.activityBar.accounts"]'));
});
