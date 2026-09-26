import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { IAction } from '../../../../../base/common/actions.js';
import type { IAccountService, AccountState, AccountLoginCompletion, AccountLoginChallenge } from '../../../../../platform/accounts/common/accountService.js';
import type { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import type { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import type { ILogService } from '../../../../../platform/log/common/log.js';
import type { ILocalizationService } from '../../../../services/localization/common/localizationService.js';

const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
for (const [name, value] of Object.entries({ window: browser.window, document: browser.window.document, Node: browser.window.Node, Element: browser.window.Element, HTMLElement: browser.window.HTMLElement, Event: browser.window.Event, MouseEvent: browser.window.MouseEvent })) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { DisposableStore } = await import('../../../../../base/common/lifecycle.js');
const { formatNlsMessage } = await import('../../../../../nls.js');
const { Emitter, Event } = await import('../../../../../base/common/event.js');
const { IAccountService: AccountServiceId } = await import('../../../../../platform/accounts/common/accountService.js');
const { IAccessibilityService: AccessibilityServiceId } = await import('../../../../../platform/accessibility/common/accessibility.js');
const { IContextMenuService: ContextMenuServiceId } = await import('../../../../../platform/contextview/browser/contextView.js');
const { ILogService: LogServiceId } = await import('../../../../../platform/log/common/log.js');
const { IDialogService: DialogServiceId } = await import('../../../../../platform/dialogs/common/dialogs.js');
const { IDialogsModel: DialogsModelId } = await import('../../../../common/dialogs.js');
const { IStorageService: StorageServiceId } = await import('../../../../../platform/storage/common/storage.js');
const { BrowserStorageService } = await import('../../../../services/storage/browser/storageService.js');
const { ILocalizationService: LocalizationServiceId } = await import('../../../../services/localization/common/localizationService.js');
const { IGitHubConnectionService: GitHubConnectionServiceId } = await import('../../../../services/accounts/common/gitHubConnectionService.js');
const { GitHubConnectionService } = await import('../../../../services/accounts/browser/gitHubConnectionService.js');
const { DialogService } = await import('../../../../services/dialogs/common/dialogService.js');
const { IMenuService, MenuId, MenusRegistry } = await import('../../../../../platform/actions/common/actions.js');
const { MenuService } = await import('../../../../../platform/actions/common/menuService.js');
const { ICommandService, CommandsRegistry } = await import('../../../../../platform/commands/common/commands.js');
const { ContextKeyService } = await import('../../../../../platform/contextkey/browser/contextKeyService.js');
const { ServiceContainer } = await import('../../../../../platform/instantiation/common/instantiation.js');
const { CommandService } = await import('../../../../services/commands/common/commandService.js');
const { GlobalCompositeBar } = await import('../../globalCompositeBar.js');

test('Activity Bar global actions open account and management menus', async () => {
	using disposables = new DisposableStore();
	const ownerDocument = browser.window.document;
	ownerDocument.body.replaceChildren();
	const services = disposables.add(new ServiceContainer());
	const commands = disposables.add(new CommandService(services));
	services.registerInstance(ICommandService, commands);
	const contextKeys = disposables.add(new ContextKeyService());
	const menus = new MenuService(commands, contextKeys);
	services.registerInstance(IMenuService, menus);
	let actions: readonly IAction[] = [];
	let closeMenu: (didCancel: boolean) => void = () => {};
	const contextMenu: IContextMenuService = {
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu(options) { actions = options.getActions?.() ?? []; closeMenu = options.onHide ?? (() => {}); },
		hideContextMenu() {},
	};
	services.registerInstance(ContextMenuServiceId, contextMenu);
	const accountsChanged = disposables.add(new Emitter<AccountState>());
	const loginCompleted = disposables.add(new Emitter<AccountLoginCompletion>());
	let accountState: AccountState = { revision: 1n, accounts: [{ provider: 'openai', accountId: 'one', displayName: 'Ash User', status: 'ready', credentialRevision: 1n }] };
	const loginMethods: string[] = [];
	const loggedOutProviders: string[] = [];
	const cancelledLogins: string[] = [];
	let delayedGitHubStart: Promise<AccountLoginChallenge> | undefined;
	const accountService: IAccountService = {
		onDidChangeAccounts: accountsChanged.event,
		onDidCompleteLogin: loginCompleted.event,
		read: async () => accountState,
		startLogin: async method => {
			loginMethods.push(method.type);
			return method.type === 'gitHubBrowser'
				? delayedGitHubStart ?? { type: 'browser', loginId: 'github-login', authorizationUrl: 'https://broker.example/authorize' }
				: { type: 'connected', loginId: 'one' };
		},
		cancelLogin: async loginId => { cancelledLogins.push(loginId); },
		logout: async provider => { loggedOutProviders.push(provider); },
	};
	services.registerInstance(AccountServiceId, accountService);
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
	const announcements: string[] = [];
	services.registerInstance(AccessibilityServiceId, { status: (message: string) => { announcements.push(message); } } as unknown as IAccessibilityService);
	const dialogs = disposables.add(new DialogService());
	services.registerInstance(DialogServiceId, dialogs);
	services.registerInstance(DialogsModelId, dialogs.model);
	const githubConnection = disposables.add(services.createInstance(GitHubConnectionService));
	services.registerInstance(GitHubConnectionServiceId, githubConnection);
	const storage = disposables.add(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, applicationId: 'code', workspaceId: 'test', backend: browser.window.localStorage, flushInterval: 0 }));
	services.registerInstance(StorageServiceId, storage);
	let settingsOpened = false;
	disposables.add(CommandsRegistry.register('test.activityBar.settings', () => { settingsOpened = true; }));
	disposables.add(MenusRegistry.appendMenuItem(MenuId.GlobalActivity, { command: { id: 'test.activityBar.settings', title: 'Settings' }, group: '2_configuration' }));
	const bar = disposables.add(services.createInstance(GlobalCompositeBar, ownerDocument.body));
	await Promise.resolve();
	const accountsButton = bar.domNode.querySelector<HTMLButtonElement>('[data-action-id="ash.activityBar.accounts"] button');
	const manageButton = bar.domNode.querySelector<HTMLButtonElement>('[data-action-id="ash.activityBar.manage"] button');
	assert.ok(accountsButton);
	assert.ok(manageButton);
	accountsButton.click();
	assert.deepEqual(actions.map(action => action.label), ['Sign out of Ash User', 'Sign in with ChatGPT', 'Connect GitHub']);
	await actions[1]?.run();
	assert.deepEqual(loginMethods, ['openAiChatGptBrowser']);
	await actions[2]?.run();
	assert.deepEqual(loginMethods, ['openAiChatGptBrowser', 'gitHubBrowser']);
	assert.equal(dialogs.model.dialogs.length, 0);
	assert.deepEqual(announcements, ['Authorize Ash in your browser to connect GitHub.']);
	closeMenu(false);
	accountsButton.click();
	assert.equal(actions[2]?.label, 'Cancel GitHub connection');
	assert.equal(actions[2]?.enabled, true);
	accountState = { revision: 2n, accounts: [...accountState.accounts, { provider: 'github', accountId: 'octocat', displayName: 'octocat', status: 'ready', credentialRevision: 1n }] };
	loginCompleted.fire({ loginId: 'github-login', status: { type: 'succeeded' }, account: accountState });
	accountsChanged.fire(accountState);
	assert.equal(dialogs.model.dialogs.length, 0);
	assert.deepEqual(announcements, ['Authorize Ash in your browser to connect GitHub.', 'GitHub account connected.']);
	closeMenu(false);
	accountsButton.click();
	assert.deepEqual(actions.map(action => action.label), ['Sign out of Ash User', 'Sign out of GitHub (octocat)', 'Sign in with ChatGPT']);
	await actions[1]?.run();
	assert.deepEqual(loggedOutProviders, ['github']);
	accountState = { revision: 3n, accounts: accountState.accounts.filter(account => account.provider !== 'github') };
	accountsChanged.fire(accountState);
	closeMenu(false);
	accountsButton.click();
	await actions[2]?.run();
	closeMenu(false);
	accountsButton.click();
	assert.equal(actions[2]?.label, 'Cancel GitHub connection');
	await actions[2]?.run();
	await Promise.resolve();
	assert.deepEqual(cancelledLogins, ['github-login']);
	closeMenu(false);
	accountsButton.click();
	assert.equal(actions[2]?.enabled, true);
	let finishStart: ((value: AccountLoginChallenge) => void) | undefined;
	delayedGitHubStart = new Promise(resolve => { finishStart = resolve; });
	const connecting = actions[2]?.run();
	closeMenu(false);
	accountsButton.click();
	assert.equal(actions[2]?.label, 'Cancel GitHub connection');
	await actions[2]?.run();
	finishStart?.({ type: 'browser', loginId: 'late-github-login', authorizationUrl: 'https://broker.example/authorize' });
	await connecting;
	delayedGitHubStart = undefined;
	assert.deepEqual(cancelledLogins, ['github-login', 'late-github-login']);
	closeMenu(false);
	accountsButton.click();
	await actions[2]?.run();
	loginCompleted.fire({ loginId: 'github-login', status: { type: 'failed', failure: { code: 'denied', message: 'Authorization denied' } }, account: accountState });
	assert.deepEqual(dialogs.model.dialogs.map(dialog => dialog.request.message), ['Could not connect GitHub. Try again.']);
	closeMenu(false);
	accountsButton.click();
	assert.equal(actions[2]?.label, 'Connect GitHub');
	assert.equal(actions[2]?.enabled, true);
	manageButton.click();
	assert.equal(actions.find(action => action.id === 'test.activityBar.settings')?.label, 'Settings');
	await actions.find(action => action.id === 'test.activityBar.settings')?.run();
	assert.equal(settingsOpened, true);
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
