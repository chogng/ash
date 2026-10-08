import { localize, localize2 } from '../../../../nls.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { MenuId, MenusRegistry } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { AppServerAvailableContext } from '../../../common/contextkeys.js';
import { TerminalCommandId } from '../common/terminal.js';
import { TerminalCreatingContext, TerminalHasActiveInstanceContext, TerminalActiveInstanceInTitleContext, TerminalActiveInstanceStateContext } from '../common/terminalContextKey.js';

/** Registers terminal menus once for the renderer; enablement comes from each window's context. */
export function setupTerminalMenus(): void {
	MenusRegistry.appendMenuItem(MenuId.TerminalTitle, {
		command: {
			id: TerminalCommandId.Focus,
			title: localize2('terminal.title.focusActive', "Focus Active Terminal"),
			tooltip: localize('terminal.title.focusActive', "Focus Active Terminal"),
		},
		when: TerminalActiveInstanceInTitleContext.isEqualTo(true),
		group: "navigation",
		order: 0,
	});
	MenusRegistry.appendMenuItem(MenuId.TerminalTitle, {
		command: {
			id: TerminalCommandId.New,
			title: localize2('terminal.title.new', "New Terminal"),
			tooltip: localize('terminal.title.new', "New Terminal"),
			icon: Lxicon.add,
			precondition: ContextKeyExpr.and(AppServerAvailableContext.isEqualTo(true), TerminalCreatingContext.isEqualTo(false)),
		},
		group: "navigation",
		order: 10,
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
		),
		group: "navigation",
		order: 20,
	});
	MenusRegistry.appendMenuItem(MenuId.TerminalTitle, {
		command: {
			id: TerminalCommandId.Kill,
			title: localize2('terminal.title.kill', "Kill Terminal"),
			tooltip: localize('terminal.title.kill', "Kill Terminal"),
			icon: Lxicon.trash,
		},
		when: TerminalHasActiveInstanceContext.isEqualTo(true),
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
}
