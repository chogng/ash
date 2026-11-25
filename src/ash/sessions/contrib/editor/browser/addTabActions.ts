import { DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { MenusRegistry, MenuId } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, type ContextKeyExpression } from '../../../../platform/contextkey/common/contextkey.js';
import { localize2 } from '../../../../nls.js';
import { AppServerAvailableContext } from '../../../../workbench/common/contextkeys.js';
import { TerminalCommandId } from '../../../../workbench/contrib/terminal/common/terminal.js';
import { NEW_FILE_TAB_COMMAND_ID } from '../../../../workbench/contrib/sessions/common/sessionCommands.js';
import { SessionsCategories } from '../../../../workbench/contrib/sessions/common/categories.js';
import { Menus } from '../../../browser/menus.js';
import { Lxicon } from '../../../../base/common/lxicons.js';

export function registerEditorStartAction(open: () => Promise<void>, when: ContextKeyExpression): IDisposable {
	const registrations = new DisposableStore();
	const command = { id: 'ash.sessions.openEditorStart', title: localize2({ bundle: 'ash', key: 'sessions.editorStart.newTab' }, 'New Tab'), icon: Lxicon.add };
	registrations.add(CommandsRegistry.register(command.id, open));
	registrations.add(MenusRegistry.appendMenuItems([Menus.SessionsEditorTabsBarAddTab, MenuId.CommandPalette]
		.map(id => ({ id, item: { command, when, group: 'navigation', order: -1 } }))));
	return registrations;
}
import { VIEW_SESSION_CHANGES_COMMAND_ID } from '../../changes/common/changes.js';

/** Contributes editor tab actions to the Code window. */
export function registerAddTabActions(
	openFiles: () => Promise<void> | false,
	openChanges: () => Promise<void> | false,
	when: ContextKeyExpression,
): IDisposable {
	const registrations = new DisposableStore();
	const actions = [
		{
			id: NEW_FILE_TAB_COMMAND_ID,
			title: localize2({ bundle: 'ash', key: 'sessions.layout.openFiles' }, 'Open Files'),
			icon: Lxicon.folder,
			run: openFiles,
		},
		{
			id: VIEW_SESSION_CHANGES_COMMAND_ID,
			title: localize2({ bundle: 'ash', key: 'sessions.layout.openChanges' }, 'Open Changes'),
			icon: Lxicon.diffChanges,
			run: openChanges,
		},
	];
	for (const [order, action] of actions.entries()) {
		registrations.add(CommandsRegistry.register(action.id, action.run));
		registrations.add(MenusRegistry.appendMenuItem(Menus.SessionsEditorStart, {
			command: { id: action.id, title: action.title, icon: action.icon }, when, group: 'navigation', order,
		}));
		registrations.add(MenusRegistry.appendMenuItem(Menus.SessionsEditorTabsBarAddTab, {
			command: { id: action.id, title: action.title }, when, group: 'navigation', order,
		}));
		registrations.add(MenusRegistry.appendMenuItems(
			[MenuId.CommandPalette, MenuId.MenubarViewMenu].map(id => ({
				id,
				item: {
					command: { id: action.id, title: action.title, category: SessionsCategories.Sessions },
					when,
					order: order + 4,
					group: '2_code_layout',
				},
			})),
		));
	}
	const terminal = {
		command: {
			id: TerminalCommandId.CreateTerminalEditor,
			title: localize2({ bundle: 'ash', key: 'terminal.title.new' }, 'New Terminal'),
		},
		when: ContextKeyExpr.and(when, AppServerAvailableContext.isEqualTo(true)),
		group: 'navigation',
		order: actions.length,
	};
	registrations.add(MenusRegistry.appendMenuItem(Menus.SessionsEditorTabsBarAddTab, terminal));
	registrations.add(MenusRegistry.appendMenuItem(Menus.SessionsEditorStart, {
		...terminal, command: { ...terminal.command, icon: Lxicon.terminalSession },
	}));
	return registrations;
}
