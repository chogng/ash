import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { IAction } from '../../../../../base/common/actions.js';
import type { IAccountService } from '../../../../../platform/accounts/common/accountService.js';
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
const { IContextMenuService: ContextMenuServiceId } = await import('../../../../../platform/contextview/browser/contextView.js');
const { ILogService: LogServiceId } = await import('../../../../../platform/log/common/log.js');
const { IStorageService: StorageServiceId } = await import('../../../../../platform/storage/common/storage.js');
const { BrowserStorageService } = await import('../../../../services/storage/browser/storageService.js');
const { ILocalizationService: LocalizationServiceId } = await import('../../../../services/localization/common/localizationService.js');
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
	const contextMenu: IContextMenuService = {
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu(options) { actions = options.getActions?.() ?? []; },
		hideContextMenu() {},
	};
	services.registerInstance(ContextMenuServiceId, contextMenu);
	const accountsChanged = disposables.add(new Emitter<Awaited<ReturnType<IAccountService['read']>>>());
	let loginCount = 0;
	const accountService: IAccountService = {
		onDidChangeAccounts: accountsChanged.event,
		onDidCompleteLogin: Event.None,
		read: async () => ({ revision: 1n, accounts: [{ provider: 'openai', accountId: 'one', displayName: 'Ash User', status: 'ready', credentialRevision: 1n }] }),
		startLogin: async () => { loginCount += 1; return { type: 'connected', loginId: 'one' }; },
		cancelLogin: async () => {},
		logout: async () => {},
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
	assert.deepEqual(actions.map(action => action.label), ['Sign out of Ash User', 'Sign in with ChatGPT']);
	await actions[1]?.run();
	assert.equal(loginCount, 1);
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
