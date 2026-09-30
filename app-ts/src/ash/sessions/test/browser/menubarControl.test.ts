import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { SubmenuAction, type IAction } from '../../../base/common/actions.js';
import { Event } from '../../../base/common/event.js';
import { installEditorTestDom } from '../../../editor/test/browser/editorTestGlobals.js';
import { MenuId, MenusRegistry } from '../../../platform/actions/common/actions.js';
import { MenuService } from '../../../platform/actions/common/menuService.js';
import { CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { ContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import type { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { ServiceContainer } from '../../../platform/instantiation/common/instantiation.js';
import { CommandService } from '../../../workbench/services/commands/common/commandService.js';
import { MenubarControl } from '../../browser/parts/titlebar/menubarControl.js';

test('Sessions menubar uses its selected shared menu sections and refreshes contributed commands', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	using globals = installEditorTestDom(browser, ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent']);
	using services = new ServiceContainer();
	using commands = new CommandService(services);
	using contextKeys = new ContextKeyService();
	const menus = new MenuService(commands, contextKeys);
	await import('../../browser/parts/menubar.contribution.js');
	let commandRuns = 0;
	using command = CommandsRegistry.register('test.sessions.menubar.command', () => { commandRuns++; });
	using fileCommand = MenusRegistry.appendMenuItem(MenuId.MenubarFileMenu, { command: { id: 'test.sessions.menubar.command', title: 'Selected command' } });
	using runCommand = MenusRegistry.appendMenuItem(MenuId.MenubarRunMenu, { command: { id: 'test.sessions.menubar.command', title: 'Excluded command' } });
	let shownActions: readonly IAction[] = [];
	let onHide: (() => void) | undefined;
	const contextMenus: IContextMenuService = {
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu(delegate) {
			shownActions = delegate.getActions?.() ?? [];
			onHide = () => delegate.onHide?.(false);
		},
		hideContextMenu() {
			onHide?.();
			onHide = undefined;
		},
	};
	using menubar = new MenubarControl(browser.window.document.body, menus, contextMenus);
	const menuButton = (): HTMLButtonElement => menubar.domNode.querySelector<HTMLButtonElement>('[data-action-id="ash.applicationMenu"] button')!;
	try {
		menuButton().click();
		assert.deepEqual(shownActions.map(action => action.label), ['File']);
		const file = shownActions[0];
		assert.ok(file instanceof SubmenuAction);
		await file.actions.find(action => action.id === 'test.sessions.menubar.command')!.run();
		assert.equal(commandRuns, 1);
		using helpCommand = MenusRegistry.appendMenuItem(MenuId.MenubarHelpMenu, { command: { id: 'test.sessions.menubar.command', title: 'Help command' } });
		assert.equal(menuButton().getAttribute('aria-expanded'), 'false');
		menuButton().click();
		assert.deepEqual(shownActions.map(action => action.label), ['File', 'Help']);
		menubar.setTrailingActions([{ id: 'test.sessions.menubar.toggle', label: 'Toggle', tooltip: 'Toggle', enabled: true, checked: true, run() {} }]);
		assert.equal(menuButton().getAttribute('aria-expanded'), 'false');
		assert.deepEqual([...menubar.domNode.querySelectorAll('button')].map(button => [button.getAttribute('aria-label'), button.getAttribute('aria-pressed')]), [['Application menu', null], ['Toggle', 'true']]);
	} finally {
		menubar.dispose();
		browser.window.close();
	}
});
