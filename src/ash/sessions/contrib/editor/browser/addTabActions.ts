import { DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { MenusRegistry, MenuId } from '../../../../platform/actions/common/actions.js';
import type { ContextKeyExpression } from '../../../../platform/contextkey/common/contextkey.js';
import { localize2 } from '../../../../nls.js';
import { NEW_FILE_TAB_COMMAND_ID } from '../../../common/sessionCommands.js';
import { SessionsCategories } from '../../../common/categories.js';
import { VIEW_SESSION_CHANGES_COMMAND_ID } from '../../changes/common/changes.js';

/** Callbacks retain the window's layout queue; tab actions do not own layout state. */
export function registerAddTabActions(
	openFiles: () => Promise<void> | false,
	openChanges: () => Promise<void> | false,
	when: ContextKeyExpression,
): IDisposable {
	const registrations = new DisposableStore();
	const actions = [
		{
			id: NEW_FILE_TAB_COMMAND_ID,
			title: localize2({ bundle: 'ash', key: 'sessions.layout.openFiles' }, 'Open Files tab'),
			icon: Lxicon.files,
			run: openFiles,
		},
		{
			id: VIEW_SESSION_CHANGES_COMMAND_ID,
			title: localize2({ bundle: 'ash', key: 'sessions.layout.openChanges' }, 'Open Changes tab'),
			icon: Lxicon.diff,
			run: openChanges,
		},
	];
	for (const [order, action] of actions.entries()) {
		registrations.add(CommandsRegistry.register(action.id, action.run));
		registrations.add(MenusRegistry.appendMenuItems([
			...([MenuId.CommandPalette, MenuId.MenubarViewMenu].map(id => ({
				id,
				item: {
					command: { id: action.id, title: action.title, category: SessionsCategories.Sessions },
					when,
					order: order + 4,
					group: '2_code_layout',
				},
			}))),
		]));
	}
	return registrations;
}
