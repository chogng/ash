import { localize, localize2 } from '../../../../nls.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CONTEXT_ACCESSIBILITY_MODE_ENABLED } from '../../../../platform/accessibility/common/accessibility.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { AppServerAvailableContext } from '../../../common/contextkeys.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { TerminalCommandId, TERMINAL_VIEW_ID } from '../common/terminal.js';
import { TerminalContextKeys, TerminalHasActiveInstanceContext } from '../common/terminalContextKey.js';
import { ITerminalProfileService } from '../../../services/terminal/common/terminal.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { TerminalProfileQuickpick } from './terminalProfileQuickpick.js';
import { ITerminalService, ITerminalGroupService, type ITerminalInstance } from '../../../services/terminal/browser/terminal.js';
import type { TerminalViewPane } from './terminalView.js';
import { MarshalledId } from '../../../../base/common/marshallingIds.js';
import { InstanceContext } from './terminalContextMenu.js';


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
	registerAction2(class SplitTerminalAction extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.Split, title: localize2('terminal.group.split', 'Terminal: Split Terminal'), f1: true,
				precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
				keybinding: {
					primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Digit5,
					mac: { primary: KeyMod.CtrlCmd | KeyCode.Backslash },
					when: TerminalContextKeys.focus.isEqualTo(true), weight: KeybindingWeight.WorkbenchContrib,
				},
			});
		}
		override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
			const parent = resolveInstance(accessor, context);
			if (!parent || parent.state !== 'running' || parent.isReadOnly || parent.shellLaunchConfig?.customPtyImplementation) return;
			await terminalView(accessor).createTerminal(parent.profile.profileId, true, parent);
			accessor.get(ITerminalService).activeInstance?.xterm?.focus();
		}
	});
	for (const [id, title, direction, key] of [
		[TerminalCommandId.FocusNextPane, localize2('terminal.group.next', 'Terminal: Focus Next Pane'), 'next', KeyCode.RightArrow],
		[TerminalCommandId.FocusPreviousPane, localize2('terminal.group.previous', 'Terminal: Focus Previous Pane'), 'previous', KeyCode.LeftArrow],
	] as const) {
		registerAction2(class FocusTerminalPaneAction extends Action2 {
			constructor() {
				super({
					id, title, f1: true, precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
					keybinding: { primary: KeyMod.CtrlCmd | KeyMod.Alt | key, when: TerminalContextKeys.focus.isEqualTo(true), weight: KeybindingWeight.WorkbenchContrib },
				});
			}
			override run(accessor: ServicesAccessor): void {
				const group = accessor.get(ITerminalGroupService).activeGroup;
				if (direction === 'next') group?.focusNextPane();
				else group?.focusPreviousPane();
			}
		});
	}
	registerAction2(class UnsplitTerminalAction extends Action2 {
		constructor() {
			super({ id: TerminalCommandId.Unsplit, title: localize2('terminal.group.unsplit', 'Terminal: Unsplit Terminal'), f1: true, precondition: TerminalHasActiveInstanceContext.isEqualTo(true) });
		}
		override run(accessor: ServicesAccessor, context?: unknown): void {
			const instance = resolveInstance(accessor, context);
			if (!instance) return;
			accessor.get(ITerminalGroupService).unsplitInstance(instance);
			instance.xterm?.focus();
		}
	});
	registerAction2(class NewWithProfileAction extends Action2 {
		constructor() {
			super({ id: TerminalCommandId.NewWithProfile, title: localize2('terminal.profile.newCommand', 'Terminal: Create New Terminal With Profile'), f1: true, precondition: AppServerAvailableContext.isEqualTo(true) });
		}
		override async run(accessor: ServicesAccessor, profileId?: unknown): Promise<void> {
			const profiles = accessor.get(ITerminalProfileService);
			const view = terminalView(accessor);
			if (profileId === undefined) {
				using picker = accessor.get(IInstantiationService).createInstance(TerminalProfileQuickpick);
				profileId = await picker.showAndGetResult('createInstance');
				if (profileId === undefined) return;
			} else {
				await profiles.refreshAvailableProfiles();
			}
			if (typeof profileId !== 'string' || !profiles.availableProfiles.some(profile => profile.profileId === profileId) && !profiles.contributedProfiles.some(profile => profileId === `extension:${profile.extensionIdentifier}/${profile.id}`)) {
				throw new TypeError(localize('terminal.profile.unknown', 'Unknown terminal profile: {0}', String(profileId)));
			}
			await view.createTerminal(profileId);
		}
	});
	registerAction2(class SelectDefaultProfileAction extends Action2 {
		constructor() {
			super({ id: TerminalCommandId.SelectDefaultProfile, title: localize2('terminal.profile.defaultCommand', 'Terminal: Select Default Profile'), f1: true, precondition: AppServerAvailableContext.isEqualTo(true) });
		}
		override async run(accessor: ServicesAccessor): Promise<void> {
			using picker = accessor.get(IInstantiationService).createInstance(TerminalProfileQuickpick);
			await picker.showAndGetResult('setDefault');
		}
	});
	registerAction2(class ScrollToPreviousCommandAction extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.ScrollToPreviousCommand,
				title: localize2('workbench.action.terminal.scrollToPreviousCommand', 'Terminal: Scroll to Previous Command'),
				precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
				keybinding: {
					primary: KeyMod.CtrlCmd | KeyCode.UpArrow,
					when: ContextKeyExpr.and(TerminalContextKeys.focus.isEqualTo(true), CONTEXT_ACCESSIBILITY_MODE_ENABLED.isEqualTo(false)),
					weight: KeybindingWeight.WorkbenchContrib,
				},
			});
		}
		override run(accessor: ServicesAccessor): void {
			scrollToCommand(accessor, 'previous');
		}
	});
	registerAction2(class ScrollToNextCommandAction extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.ScrollToNextCommand,
				title: localize2('workbench.action.terminal.scrollToNextCommand', 'Terminal: Scroll to Next Command'),
				precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
				keybinding: {
					primary: KeyMod.CtrlCmd | KeyCode.DownArrow,
					when: ContextKeyExpr.and(TerminalContextKeys.focus.isEqualTo(true), CONTEXT_ACCESSIBILITY_MODE_ENABLED.isEqualTo(false)),
					weight: KeybindingWeight.WorkbenchContrib,
				},
			});
		}
		override run(accessor: ServicesAccessor): void {
			scrollToCommand(accessor, 'next');
		}
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

function scrollToCommand(accessor: ServicesAccessor, direction: 'previous' | 'next'): void {
	const instance = accessor.get(ITerminalService).activeInstance;
	const screen = instance?.xterm;
	if (!screen) return;
	if (direction === 'previous') screen.scrollToPreviousCommand();
	else screen.scrollToNextCommand();
	screen.focus();
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
