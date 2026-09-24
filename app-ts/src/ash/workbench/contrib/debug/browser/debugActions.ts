import { Action2, MenuId, registerAction2 } from "../../../../platform/actions/common/actions.js";
import { Keybinding, logicalKey } from "../../../../base/common/keybindings.js";
import { type ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { IDebugService } from "../../../services/debug/common/debugService.js";
import { IDebugConsoleService } from "../../../services/debug/common/debugConsoleService.js";
import { IViewsService } from "../../../services/views/browser/viewsService.js";
import { CLEAR_DEBUG_CONSOLE_COMMAND_ID, CONTINUE_DEBUG_COMMAND_ID, DEBUG_CONSOLE_VIEW_ID, DEBUG_VIEW_ID, FOCUS_DEBUG_CONSOLE_COMMAND_ID, PAUSE_DEBUG_COMMAND_ID, RESTART_DEBUG_COMMAND_ID, START_DEBUG_COMMAND_ID, STEP_INTO_DEBUG_COMMAND_ID, STEP_OUT_DEBUG_COMMAND_ID, STEP_OVER_DEBUG_COMMAND_ID, STOP_ALL_DEBUG_COMMAND_ID, STOP_DEBUG_COMMAND_ID } from "../common/debug.js";

registerAction2(class StartDebugAction extends Action2 {
	constructor() { super({ id: START_DEBUG_COMMAND_ID, title: "Start Debugging", f1: true, keybinding: { primary: Keybinding.single(logicalKey("F5")) }, menu: { id: MenuId.MenubarRunMenu, group: "1_debug", order: 1 } }); }
	override run(accessor: ServicesAccessor): void {
		const debug = accessor.get(IDebugService);
		accessor.get(IViewsService).focusView(DEBUG_VIEW_ID);
		void (async () => {
			if (debug.session?.state === "stopped") { await debug.session.continue(); return; }
			const configurations = await debug.refresh();
			if (configurations[0]) await debug.start(configurations[0]);
			else throw new Error("No debug configuration found in .vscode/launch.json");
		})().catch(reportError);
	}
});

registerAction2(class StopDebugAction extends Action2 {
	constructor() { super({ id: STOP_DEBUG_COMMAND_ID, title: "Stop Debugging", f1: true, keybinding: { primary: Keybinding.single(logicalKey("F5", { shiftKey: true })) }, menu: { id: MenuId.MenubarRunMenu, group: "1_debug", order: 2 } }); }
	override run(accessor: ServicesAccessor): void { void accessor.get(IDebugService).stop().catch(reportError); }
});

registerAction2(class RestartDebugAction extends Action2 {
	constructor() { super({ id: RESTART_DEBUG_COMMAND_ID, title: "Restart Debugging", f1: true, keybinding: { primary: Keybinding.single(logicalKey("F5", { ctrlKey: true, shiftKey: true })) }, menu: { id: MenuId.MenubarRunMenu, group: "1_debug", order: 3 } }); }
	override run(accessor: ServicesAccessor): void { void accessor.get(IDebugService).restart().catch(reportError); }
});

registerAction2(class StopAllDebugAction extends Action2 {
	constructor() { super({ id: STOP_ALL_DEBUG_COMMAND_ID, title: "Stop All Debugging", f1: true, menu: { id: MenuId.MenubarRunMenu, group: "1_debug", order: 4 } }); }
	override run(accessor: ServicesAccessor): void { void accessor.get(IDebugService).stopAll().catch(reportError); }
});

registerAction2(class FocusDebugConsoleAction extends Action2 {
	constructor() { super({ id: FOCUS_DEBUG_CONSOLE_COMMAND_ID, title: "Focus on Debug Console View", f1: true }); }
	override run(accessor: ServicesAccessor): void { accessor.get(IViewsService).focusView(DEBUG_CONSOLE_VIEW_ID); }
});

registerAction2(class ClearDebugConsoleAction extends Action2 {
	constructor() { super({ id: CLEAR_DEBUG_CONSOLE_COMMAND_ID, title: "Clear Console", f1: true }); }
	override run(accessor: ServicesAccessor): void { accessor.get(IDebugConsoleService).clear(); }
});

for (const [id, title, keybinding, operation] of [
	[CONTINUE_DEBUG_COMMAND_ID, "Continue", undefined, "continue"],
	[PAUSE_DEBUG_COMMAND_ID, "Pause", Keybinding.single(logicalKey("F6")), "pause"],
	[STEP_OVER_DEBUG_COMMAND_ID, "Step Over", Keybinding.single(logicalKey("F10")), "stepOver"],
	[STEP_INTO_DEBUG_COMMAND_ID, "Step Into", Keybinding.single(logicalKey("F11")), "stepInto"],
	[STEP_OUT_DEBUG_COMMAND_ID, "Step Out", Keybinding.single(logicalKey("F11", { shiftKey: true })), "stepOut"],
] as const) {
	registerAction2(class DebugSessionAction extends Action2 {
		constructor() { super({ id, title, f1: true, ...(keybinding ? { keybinding: { primary: keybinding } } : {}) }); }
		override run(accessor: ServicesAccessor): void {
			const session = accessor.get(IDebugService).session;
			if (!session) return;
			void session[operation]().catch(reportError);
		}
	});
}

function reportError(error: unknown): void { console.error("Debug command failed", error); }
