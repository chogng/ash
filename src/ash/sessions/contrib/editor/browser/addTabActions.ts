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
import { EmptyFileEditorInput } from '../../../../workbench/contrib/sessions/browser/emptyFileEditorInput.js';
import { VIEW_SESSION_CHANGES_COMMAND_ID } from '../../changes/common/changes.js';

export const NEW_BROWSER_TAB_COMMAND_ID = 'ash.sessions.newBrowserTab';

export function registerAddTabActions(
	openFiles: () => Promise<void> | false,
	openChanges: () => Promise<void> | false,
	filesWhen: ContextKeyExpression,
	codeWhen: ContextKeyExpression,
): IDisposable {
	const registrations = new DisposableStore();
	const changes = {
		id: VIEW_SESSION_CHANGES_COMMAND_ID,
		title: localize2({ bundle: 'ash', key: 'sessions.layout.openChanges' }, 'Open Changes'),
		icon: Lxicon.diffChanges,
		run: openChanges,
		when: codeWhen,
	};
	const actions = [
		{
			id: NEW_FILE_TAB_COMMAND_ID,
			title: localize2({ bundle: 'ash', key: 'sessions.layout.openFiles' }, 'Open Files'),
			icon: EmptyFileEditorInput.ICON,
			run: openFiles,
			when: filesWhen,
		},
		changes,
	];
	for (const [order, action] of actions.entries()) {
		registrations.add(CommandsRegistry.register(action.id, () => action.run()));
		for (const id of [Menus.SessionsEditorTabsBarAddTab, Menus.SessionsEmptyEditorGroupAddTab]) {
			registrations.add(MenusRegistry.appendMenuItem(id, {
				command: { id: action.id, title: action.title, icon: action.icon }, when: action.when, group: 'navigation', order,
			}));
		}
		registrations.add(MenusRegistry.appendMenuItems(
			[MenuId.CommandPalette, MenuId.MenubarViewMenu].map(id => ({
				id,
				item: {
					command: { id: action.id, title: action.title, category: SessionsCategories.Sessions },
					when: action.when,
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
		when: ContextKeyExpr.and(codeWhen, AppServerAvailableContext.isEqualTo(true)),
		group: 'navigation',
		order: actions.length,
	};
	registrations.add(MenusRegistry.appendMenuItem(Menus.SessionsEditorTabsBarAddTab, terminal));
	registrations.add(MenusRegistry.appendMenuItem(Menus.SessionsEmptyEditorGroupAddTab, {
		...terminal, command: { ...terminal.command, icon: Lxicon.terminalSession },
	}));
	return registrations;
}
