import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { AppServerAvailableContext } from '../../../common/contextkeys.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { TerminalCommandId, TERMINAL_VIEW_ID } from '../common/terminal.js';
import { ITerminalService } from './terminal.js';
import type { TerminalViewPane } from './terminalView.js';
import { MarshalledId } from '../../../../base/common/marshallingIds.js';
import { InstanceContext } from './terminalContextMenu.js';
import type { ITerminalInstance } from './terminal.js';

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
				const instance = resolveInstance(accessor, instanceId)!;
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
	CommandsRegistry.register(TerminalCommandId.Relaunch, async (accessor, context) => {
		if (context === undefined) return terminalView(accessor).relaunchActive();
		const instance = resolveInstance(accessor, context)!;
		if (instance.state === 'running' || instance.state === 'reconnecting') return;
		await accessor.get(ITerminalService).relaunchTerminal(instance, instance.xterm?.dimensions() ?? { cols: 80, rows: 24 });
	});
	CommandsRegistry.register(TerminalCommandId.Kill, (accessor, context) => context === undefined
		? terminalView(accessor).killActive() : accessor.get(ITerminalService).closeTerminal(resolveInstance(accessor, context)!));
	CommandsRegistry.register(TerminalCommandId.Clear, (accessor, context) => {
		if (context === undefined) return terminalView(accessor).clearActive();
		resolveInstance(accessor, context)!.clearBuffer();
	});
}

/** Validate command contexts once, then resolve identity through the invoking window's owner. */
function resolveInstance(accessor: ServicesAccessor, context: unknown): ITerminalInstance | undefined {
	const terminals = accessor.get(ITerminalService);
	if (context === undefined) return terminals.activeInstance;
	let instance: ITerminalInstance | undefined;
	if (typeof context === 'string') {
		instance = terminals.instances.find(instance => instance.id === context);
	} else {
		const id = context instanceof InstanceContext ? context.instanceId : context && typeof context === 'object'
			&& '$mid' in context && context.$mid === MarshalledId.TerminalContext && 'instanceId' in context ? context.instanceId : undefined;
		if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
			throw new TypeError(localize('terminal.context.invalid', 'Invalid terminal instance context'));
		}
		instance = terminals.instances.find(instance => instance.instanceId === id);
	}
	if (!instance) throw new Error(localize('terminal.context.closed', 'This terminal has been closed'));
	return instance;
}

function terminalView(accessor: ServicesAccessor): TerminalViewPane {
	const view = accessor.get(IViewsService).getViewWithId<TerminalViewPane>(TERMINAL_VIEW_ID);
	if (!view) { throw new Error(localize('terminal.view.unavailable', 'The terminal view is unavailable')); }
	return view;
}
