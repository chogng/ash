import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { IAction } from '../../../base/common/actions.js';
import { Event } from '../../../base/common/event.js';
import type { IAccountService } from '../../../platform/accounts/common/accountService.js';
import type { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { SessionsAccountMenu } from '../../contrib/accounts/browser/sessionsAccountMenu.js';
import type { SessionsPreferences } from '../../contrib/preferences/browser/sessionsPreferences.js';

test('Sessions account menu opens its own settings and account actions', async () => {
	const browser = new JSDOM('<!doctype html><button></button>');
	const anchor = browser.window.document.querySelector('button')!;
	const loggedOut: string[] = [];
	let settingsOpened = 0;
	let returnedToWorkbench = 0;
	let actions: readonly IAction[] = [];
	let hide: (() => void) | undefined;
	const accounts: IAccountService = {
		onDidChangeAccounts: Event.None,
		onDidCompleteLogin: Event.None,
		read: async () => ({ revision: 1n, accounts: [{ provider: 'chatgpt-subscription', accountId: 'one', displayName: 'Ash User', plan: 'Pro', status: 'ready', credentialRevision: 1n }] }),
		startLogin: async () => ({ type: 'connected', loginId: 'one' }),
		cancelLogin: async () => { },
		logout: async provider => { loggedOut.push(provider); },
	};
	const contextMenus: IContextMenuService = {
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu(delegate) {
			actions = delegate.getActions?.() ?? [];
			hide = () => delegate.onHide?.(false);
		},
		hideContextMenu() { },
	};
	const preferences = { open: async () => { settingsOpened++; } } as SessionsPreferences;
	using menu = new SessionsAccountMenu(accounts, contextMenus, preferences, () => { returnedToWorkbench++; });
	await Promise.resolve();
	menu.show(anchor);
	assert.deepEqual(actions.map(action => [action.label, action.enabled]), [
		['Ash User · Pro', false],
		['', false],
		['Settings', true],
		['Sign out of Ash User', true],
		['', false],
		['Return to Workbench', true],
	]);
	assert.equal(anchor.getAttribute('aria-expanded'), 'true');
	await actions[2]?.run();
	await actions[3]?.run();
	await actions[5]?.run();
	assert.deepEqual({ settingsOpened, loggedOut, returnedToWorkbench }, { settingsOpened: 1, loggedOut: ['chatgpt-subscription'], returnedToWorkbench: 1 });
	hide?.();
	assert.equal(anchor.getAttribute('aria-expanded'), 'false');
	browser.window.close();
});

test('Sessions settings remain available when accounts cannot be loaded', async () => {
	const browser = new JSDOM('<!doctype html><button></button>');
	const anchor = browser.window.document.querySelector('button')!;
	let actions: readonly IAction[] = [];
	let settingsOpened = 0;
	let returnedToWorkbench = 0;
	const accounts: IAccountService = {
		onDidChangeAccounts: Event.None,
		onDidCompleteLogin: Event.None,
		read: async () => { throw new Error('Account service unavailable'); },
		startLogin: async () => ({ type: 'connected', loginId: 'one' }),
		cancelLogin: async () => { },
		logout: async () => { },
	};
	const contextMenus: IContextMenuService = {
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu(delegate) { actions = delegate.getActions?.() ?? []; },
		hideContextMenu() { },
	};
	const preferences = { open: async () => { settingsOpened++; } } as SessionsPreferences;
	using menu = new SessionsAccountMenu(accounts, contextMenus, preferences, () => { returnedToWorkbench++; });
	await Promise.resolve();
	menu.show(anchor);
	assert.deepEqual(actions.map(action => [action.label, action.enabled]), [
		['Accounts unavailable', false],
		['', false],
		['Settings', true],
		['', false],
		['Return to Workbench', true],
	]);
	await actions[2]?.run();
	await actions[4]?.run();
	assert.deepEqual({ settingsOpened, returnedToWorkbench }, { settingsOpened: 1, returnedToWorkbench: 1 });
	browser.window.close();
});
