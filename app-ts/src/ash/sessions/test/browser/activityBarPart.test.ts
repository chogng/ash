import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { IAction } from '../../../base/common/actions.js';
import type { IAccountService } from '../../../platform/accounts/common/accountService.js';
import type { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';

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

const { Event } = await import('../../../base/common/event.js');
const { ActivityBarPart } = await import('../../browser/parts/activityBarPart.js');

test('Sessions Activity Bar exposes Chat, unavailable views, and account actions', async () => {
	const ownerDocument = browser.window.document;
	ownerDocument.body.replaceChildren();
	let listFocuses = 0;
	let shownActions: readonly IAction[] = [];
	let hideMenu: (() => void) | undefined;
	const logoutProviders: string[] = [];
	const loginMethods: string[] = [];
	const accounts: IAccountService = {
		onDidChangeAccounts: Event.None,
		onDidCompleteLogin: Event.None,
		read: async () => ({
			revision: 1n,
			accounts: [{ provider: 'openai', accountId: 'one', displayName: 'Ash User', status: 'ready', credentialRevision: 1n }],
		}),
		startLogin: async method => {
			loginMethods.push(method.type);
			return { type: 'connected', loginId: 'one' };
		},
		cancelLogin: async () => {},
		logout: async provider => { logoutProviders.push(provider); },
	};
	const contextMenu: IContextMenuService = {
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu(delegate) {
			shownActions = delegate.getActions?.() ?? [];
			hideMenu = () => delegate.onHide?.(false);
		},
		hideContextMenu() {},
	};
	const bar = new ActivityBarPart(ownerDocument.body, { focusList: () => { listFocuses++; } }, accounts, contextMenu);
	try {
		const buttons = [...bar.domNode.querySelectorAll<HTMLButtonElement>('button')];
		assert.deepEqual(buttons.map(button => ({
			icon: button.querySelector('svg')?.getAttribute('data-ash-icon-id'),
			disabled: button.disabled,
		})), [
			{ icon: 'chat-2', disabled: false },
			{ icon: 'colab', disabled: true },
			{ icon: 'device-mobile', disabled: true },
			{ icon: 'account', disabled: false },
		]);
		assert.equal(buttons[0]?.getAttribute('aria-current'), 'page');
		buttons[0]?.click();
		assert.equal(listFocuses, 1);
		buttons[3]?.click();
		await Promise.resolve();
		assert.deepEqual(shownActions.map(action => action.label), ['Sign out of Ash User', 'Sign in with ChatGPT']);
		assert.equal(buttons[3]?.getAttribute('aria-expanded'), 'true');
		await shownActions[0]?.run();
		await shownActions[1]?.run();
		assert.deepEqual({ logoutProviders, loginMethods }, { logoutProviders: ['openai'], loginMethods: ['openAiChatGptBrowser'] });
		hideMenu?.();
		assert.equal(buttons[3]?.getAttribute('aria-expanded'), 'false');
	} finally {
		bar.dispose();
	}
});
