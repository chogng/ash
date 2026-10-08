import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { AppServerAvailableContext } from '../../../common/contextkeys.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { TerminalCommandId, TERMINAL_VIEW_ID } from '../common/terminal.js';
import { ITerminalService } from './terminal.js';
import type { TerminalViewPane } from './terminalView.js';

/** Command definitions use the invoking window's services, never a retained View callback. */
export function registerTerminalActions(): void {
	registerAction2(class FocusTerminalAction extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.Focus,
				title: localize2({ bundle: "ash", key: "workbench.focusTerminal" }, "Focus Terminal"),
				f1: true, precondition: AppServerAvailableContext.isEqualTo(true),
				menu: { id: MenuId.MenubarTerminalMenu, group: "1_terminal", order: 1 },
			});
		}

		override run(accessor: ServicesAccessor, instanceId?: unknown): Promise<boolean> {
			if (instanceId !== undefined) {
				const terminals = accessor.get(ITerminalService);
				const instance = terminals.instances.find(instance => instance.id === instanceId);
				if (!instance) { throw new Error(localize('terminal.context.closed', 'This terminal has been closed')); }
				terminals.setActiveInstance(instance);
			}
			return accessor.get(IViewsService).focusView(TERMINAL_VIEW_ID);
		}
	});

	CommandsRegistry.register(TerminalCommandId.New, accessor => terminalView(accessor).createTerminal());
	CommandsRegistry.register(TerminalCommandId.NewWithProfile, async (accessor, profileId) => {
		const profiles = await accessor.get(ITerminalService).getProfiles();
		if (typeof profileId !== 'string' || !profiles.some(profile => profile.profileId === profileId)) {
			throw new TypeError(`Unknown terminal profile: ${String(profileId)}`);
		}
		return terminalView(accessor).createTerminal(profileId);
	});
	CommandsRegistry.register(TerminalCommandId.Relaunch, accessor => terminalView(accessor).relaunchActive());
	CommandsRegistry.register(TerminalCommandId.Kill, accessor => terminalView(accessor).killActive());
	CommandsRegistry.register(TerminalCommandId.Clear, accessor => terminalView(accessor).clearActive());
}

function terminalView(accessor: ServicesAccessor): TerminalViewPane {
	const view = accessor.get(IViewsService).getViewWithId<TerminalViewPane>(TERMINAL_VIEW_ID);
	if (!view) { throw new Error(localize('terminal.view.unavailable', 'The terminal view is unavailable')); }
	return view;
}
