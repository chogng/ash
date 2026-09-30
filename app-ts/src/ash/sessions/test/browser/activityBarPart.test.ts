import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { IAction } from '../../../base/common/actions.js';
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
const { ActivityBarPart } = await import('../../browser/parts/activitybar/activityBarPart.js');
const { SessionsConfiguration } = await import('../../common/configuration.js');
const { ActivityBarPosition, WorkbenchConfiguration } = await import('../../../workbench/common/configuration.js');
const { WorkbenchConfigurationService } = await import('../../../workbench/services/configuration/browser/configurationService.js');

test('Sessions Activity Bar selects Chat, Collaboration, Library, and Code pages', async () => {
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
	const bar = new ActivityBarPart(ownerDocument.body, {
		focusList: () => { listFocuses++; },
		selectPage: page => { selectedPages.push(page); },
		showAccountMenu: async anchor => { accountAnchor = anchor; },
	}, configuration, contextMenu);
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
			{ icon: 'device-mobile', disabled: true },
			{ icon: 'account', disabled: false },
		]);
		assert.deepEqual([...bar.domNode.querySelectorAll('.ash-sessions-activity-top, .ash-sessions-activity-bottom')].map(group =>
			[...group.querySelectorAll('button')].map(button => button.getAttribute('aria-label')),
		), [['Chat', 'Collaboration', 'Library', 'Code'], ['Mobile devices (coming soon)', 'Accounts']]);
		assert.ok(buttons.every(button => button.classList.contains('icon-only')));
		assert.equal(buttons[0]?.getAttribute('aria-current'), 'page');
		buttons[1]?.click();
		bar.selectPage('colab');
		assert.deepEqual([buttons[0], buttons[1], buttons[2]].map(button => [button?.querySelector('svg')?.getAttribute('data-ash-icon-id'), button?.getAttribute('aria-current')]), [
			['chat-2', null], ['colab-filled', 'page'], ['library', null],
		]);
		buttons[2]?.click();
		bar.selectPage('library');
		assert.deepEqual([buttons[0], buttons[1], buttons[2]].map(button => [button?.querySelector('svg')?.getAttribute('data-ash-icon-id'), button?.getAttribute('aria-current')]), [
			['chat-2', null], ['colab', null], ['library-filled', 'page'],
		]);
		buttons[3]?.click();
		bar.selectPage('code');
		assert.deepEqual(buttons.slice(0, 4).map(button => [button.classList.contains('selected'), button.getAttribute('aria-current')]), [
			[false, null], [false, null], [false, null], [true, 'page'],
		]);
		buttons[0]?.click();
		bar.selectPage('chat');
		assert.deepEqual(selectedPages, ['colab', 'library', 'code', 'chat']);
		assert.equal(buttons[0]?.getAttribute('aria-current'), 'page');
		assert.equal(buttons[3]?.getAttribute('aria-current'), null);
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
	const bar = new ActivityBarPart(ownerDocument.body, { focusList() {}, selectPage() {}, async showAccountMenu() {} }, configuration, contextMenu);
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
		assert.deepEqual(shownActions.map(action => action.label), ['Activity Bar Position']);
	} finally {
		bar.dispose();
		configuration.dispose();
	}
});
