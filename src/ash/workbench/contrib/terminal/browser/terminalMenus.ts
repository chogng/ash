import { localize, localize2 } from '../../../../nls.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { newTerminalIcon, killTerminalIcon } from './terminalIcons.js';
import { MenuId, MenusRegistry } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { AppServerAvailableContext } from '../../../common/contextkeys.js';
import { TerminalCommandId } from '../common/terminal.js';
import { TerminalCreatingContext, TerminalHasActiveInstanceContext, TerminalActiveInstanceInTitleContext, TerminalActiveInstanceStateContext, TerminalViewInlineActionsContext } from '../common/terminalContextKey.js';

/** Registers terminal menus once for the renderer; enablement comes from each window's context. */
export function setupTerminalMenus(): void {
	for (const [id, title, group, order] of [
		[TerminalCommandId.ConfigureTerminalSettings, localize2('terminal.configureSettings', 'Configure Terminal Settings'), '3_configure', 1],
		[TerminalCommandId.SelectDefaultProfile, localize2('terminal.title.selectDefaultProfile', 'Select Default Profile'), '3_configure', 2],
		['workbench.action.tasks.runTask', localize2('terminal.runTask', 'Run Task...'), '4_tasks', 1],
		['workbench.action.tasks.configureTaskRunner', localize2('terminal.configureTasks', 'Configure Tasks...'), '4_tasks', 2],
	] as const) {
		MenusRegistry.appendMenuItem(MenuId.TerminalNewDropdownContext, {
			command: { id, title, precondition: id !== TerminalCommandId.ConfigureTerminalSettings ? AppServerAvailableContext.isEqualTo(true) : undefined },
			group, order,
		});
	}

	for (const item of [
		{ id: TerminalCommandId.Rename, title: localize2('terminal.rename.menu', 'Rename Terminal') },
		{ id: TerminalCommandId.ChangeIcon, title: localize2('terminal.icon.title', 'Change Terminal Icon') },
		{ id: TerminalCommandId.MoveToEditor, title: localize2('terminal.editor.moveToEditorMenu', 'Move Terminal into Editor Area') },
		{ id: TerminalCommandId.Split, title: localize2('terminal.group.splitMenu', 'Split Terminal'), when: TerminalActiveInstanceStateContext.isEqualTo('running') },
		{ id: TerminalCommandId.Join, title: localize2('terminal.group.joinMenu', 'Join or Reorder Terminals...') },
		{ id: TerminalCommandId.Unsplit, title: localize2('terminal.group.unsplitMenu', 'Unsplit Terminal') },
		{ id: TerminalCommandId.Focus, title: localize2('terminal.context.focus', 'Focus Terminal') },
		{ id: TerminalCommandId.Clear, title: localize2('terminal.context.clear', 'Clear Terminal') },
		{
			id: TerminalCommandId.Relaunch, title: localize2('terminal.context.relaunch', 'Relaunch Terminal'), when: ContextKeyExpr.and(
				ContextKeyExpr.notEquals(TerminalActiveInstanceStateContext.key, 'running'), ContextKeyExpr.notEquals(TerminalActiveInstanceStateContext.key, 'reconnecting'))
		},
		{ id: TerminalCommandId.Kill, title: localize2('terminal.context.kill', 'Kill Terminal') },
	]) {
		MenusRegistry.appendMenuItem(MenuId.TerminalInstanceContext, {
			command: { id: item.id, title: item.title }, when: item.when, group: '1_terminal',
		});
	}
	MenusRegistry.appendMenuItem(MenuId.TerminalTitle, {
		command: {
			id: TerminalCommandId.Focus,
			title: localize2('terminal.title.focusActive', "Focus Active Terminal"),
			tooltip: localize('terminal.title.focusActive', "Focus Active Terminal"),
		},
		alt: { id: TerminalCommandId.Split, title: localize2('terminal.group.splitMenu', 'Split Terminal'), icon: Lxicon.splitHorizontal },
		when: TerminalActiveInstanceInTitleContext.isEqualTo(true),
		group: "navigation",
		order: 0,
	});
	MenusRegistry.appendMenuItem(MenuId.TerminalTitle, {
		command: {
			id: TerminalCommandId.New,
			title: localize2('terminal.title.new', "New Terminal"),
			tooltip: localize('terminal.title.new', "New Terminal"),
			icon: newTerminalIcon,
			precondition: ContextKeyExpr.and(AppServerAvailableContext.isEqualTo(true), TerminalCreatingContext.isEqualTo(false)),
		},
		alt: { id: TerminalCommandId.Split, title: localize2('terminal.group.splitMenu', 'Split Terminal'), icon: Lxicon.splitHorizontal, precondition: ContextKeyExpr.and(TerminalHasActiveInstanceContext.isEqualTo(true), TerminalCreatingContext.isEqualTo(false), TerminalActiveInstanceStateContext.isEqualTo('running')) },
		group: "navigation",
		order: 10,
	});
	MenusRegistry.appendMenuItem(MenuId.TerminalTitle, {
		command: {
			id: TerminalCommandId.Split,
			title: localize2('terminal.group.splitMenu', 'Split Terminal'),
			icon: Lxicon.splitHorizontal,
			precondition: ContextKeyExpr.and(TerminalCreatingContext.isEqualTo(false), TerminalActiveInstanceStateContext.isEqualTo('running')),
		},
		when: TerminalViewInlineActionsContext.isEqualTo(true),
		group: 'navigation', order: 20,
	});
	MenusRegistry.appendMenuItem(MenuId.TerminalTitle, {
		command: {
			id: TerminalCommandId.Relaunch,
			title: localize2('terminal.title.relaunch', "Relaunch Terminal"),
			tooltip: localize('terminal.title.relaunch', "Relaunch Terminal"),
			icon: Lxicon.history,
		},
		when: ContextKeyExpr.and(
			TerminalHasActiveInstanceContext.isEqualTo(true),
			ContextKeyExpr.notEquals(TerminalActiveInstanceStateContext.key, "running"),
			ContextKeyExpr.notEquals(TerminalActiveInstanceStateContext.key, 'reconnecting'),
		),
		group: "1_terminal",
		order: 20,
	});
	MenusRegistry.appendMenuItem(MenuId.TerminalTitle, {
		command: {
			id: TerminalCommandId.Kill,
			title: localize2('terminal.title.kill', "Kill Terminal"),
			tooltip: localize('terminal.title.kill', "Kill Terminal"),
			icon: killTerminalIcon,
		},
		when: TerminalViewInlineActionsContext.isEqualTo(true),
		group: "navigation",
		order: 30,
	});
	MenusRegistry.appendMenuItem(MenuId.TerminalTitle, {
		command: {
			id: TerminalCommandId.Clear,
			title: localize2('terminal.title.clear', "Clear Terminal"),
			tooltip: localize('terminal.title.clear', "Clear Terminal"),
		},
		group: "1_terminal",
		order: 10,
	});
	MenusRegistry.appendMenuItem(MenuId.TerminalTitle, {
		command: { id: TerminalCommandId.SelectDefaultProfile, title: localize2('terminal.title.selectDefaultProfile', 'Select Default Profile') },
		group: '2_configuration', order: 10,
	});
}
