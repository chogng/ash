import './debugCommands.js';
import { AppServerAvailableContext } from '../../../common/contextkeys.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { type URI } from '../../../../base/common/uri.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { DebugConfigurationProviderTriggerKind, type DebugConfiguration, type IDebugConfiguration, type IDebugCompound } from '../../../services/debug/common/debugService.js';
import { SELECT_AND_START_ID } from '../common/debug.js';
import { CONTEXT_DEBUG_STATE } from '../common/debug.js';
import { localize, localize2 } from '../../../../nls.js';
import { IEditorPartsService } from '../../../browser/parts/editor/editorParts.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { DisassemblyView } from './disassemblyView.js';
import { DisassemblyViewInput } from '../common/disassemblyViewInput.js';
import { OPEN_DISASSEMBLY_VIEW_COMMAND_ID } from '../common/debug.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { Action2, MenuId, registerAction2 } from "../../../../platform/actions/common/actions.js";
import { Keybinding, logicalKey } from "../../../../base/common/keybindings.js";
import { type ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { IDebugService } from "../../../services/debug/common/debugService.js";
import { IDebugConsoleService } from "../../../services/debug/common/debugConsoleService.js";
import { IViewsService } from "../../../services/views/common/viewsService.js";
import { CLEAR_DEBUG_CONSOLE_COMMAND_ID, CONTINUE_DEBUG_COMMAND_ID, DEBUG_CONSOLE_VIEW_ID, DEBUG_VIEW_ID, FOCUS_DEBUG_CONSOLE_COMMAND_ID, PAUSE_DEBUG_COMMAND_ID, RESTART_DEBUG_COMMAND_ID, START_DEBUG_COMMAND_ID, STEP_INTO_DEBUG_COMMAND_ID, STEP_OUT_DEBUG_COMMAND_ID, STEP_OVER_DEBUG_COMMAND_ID, STOP_ALL_DEBUG_COMMAND_ID, STOP_DEBUG_COMMAND_ID } from "../common/debug.js";

registerAction2(class OpenDisassemblyAction extends Action2 {
	constructor() { super({ id: OPEN_DISASSEMBLY_VIEW_COMMAND_ID, title: localize2('debug.openDisassembly', 'Open Disassembly View'), f1: true }); }
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const session = accessor.get(IDebugService).session;
		if (!session?.capabilities.supportsDisassembleRequest) { throw new Error(localize('debug.disassemblyUnsupported', 'The debug adapter does not support disassembly.')); }
		if (session.state !== 'stopped') { throw new Error(localize('debug.disassemblyRequiresPause', 'Pause debugging to view disassembly.')); }
		await accessor.get(IEditorService).openEditor(new DisassemblyViewInput(), { pinned: true });
	}
});

registerAction2(class ToggleBreakpointAction extends Action2 {
	constructor() {
		super({ id: 'editor.debug.action.toggleBreakpoint', title: localize2('debug.toggleBreakpoint', 'Toggle Breakpoint'), f1: true, keybinding: { primary: Keybinding.single(logicalKey('F9')), when: EditorContextKeys.editorTextFocus.isEqualTo(true) } });
	}
	override run(accessor: ServicesAccessor): void {
		const editors = accessor.get(ICodeEditorService);
		const editor = editors.getFocusedCodeEditor() ?? editors.getActiveCodeEditor();
		const model = editor?.getModel();
		const position = editor?.getPosition();
		if (model && position) { accessor.get(IDebugService).toggleBreakpoint(model.uri, position.lineNumber); }
	}
});

registerAction2(class StartDebugAction extends Action2 {
	constructor() { super({ id: START_DEBUG_COMMAND_ID, title: localize2({ bundle: 'ash', key: 'debug.start' }, "Start Debugging"), f1: true, precondition: AppServerAvailableContext.isEqualTo(true), keybinding: { primary: Keybinding.single(logicalKey("F5")) }, menu: { id: MenuId.MenubarRunMenu, group: "1_debug", order: 1 } }); }
	override run(accessor: ServicesAccessor): void {
		const debug = accessor.get(IDebugService);
		const views = accessor.get(IViewsService);
		void (async () => {
			await views.focusView(DEBUG_VIEW_ID);
			if (debug.session?.state === "stopped") { await debug.session.continue(); return; }
			const configurations = await debug.refresh();
			if (configurations[0]) await debug.start(configurations[0]);
			else throw new Error("No debug configuration found in .vscode/launch.json");
		})().catch(reportError);
	}
});

type DebugConfigurationPick = IQuickPickItem & (
	{ readonly kind: 'configured'; readonly configuration: IDebugConfiguration; }
	| { readonly kind: 'compound'; readonly compound: IDebugCompound; }
	| { readonly kind: 'dynamic'; readonly folder: URI; readonly configuration: DebugConfiguration; }
);

registerAction2(class SelectAndStartDebugAction extends Action2 {
	constructor() { super({ id: SELECT_AND_START_ID, title: localize2({ bundle: 'ash', key: 'debug.selectAndStart' }, 'Select and Start Debugging'), f1: true, precondition: AppServerAvailableContext.isEqualTo(true) }); }
	override async run(accessor: ServicesAccessor): Promise<void> {
		const debug = accessor.get(IDebugService);
		const workspace = accessor.get(IWorkspaceContextService);
		const quickInput = accessor.get(IQuickInputService);
		let selected: DebugConfigurationPick | undefined;
		try {
			using resources = new DisposableStore();
			const picker = resources.add(quickInput.createQuickPick<DebugConfigurationPick>());
			const controller = new AbortController();
			resources.add(toDisposable(() => controller.abort()));
			picker.ariaLabel = picker.placeholder = localize({ bundle: 'ash', key: 'debug.selectConfiguration' }, 'Select a debug configuration');
			picker.busy = true;
			selected = await new Promise<DebugConfigurationPick | undefined>((resolve, reject) => {
				// Hiding the picker revokes discovery, including pending extension callbacks.
				const cancel = (): void => { controller.abort(); resolve(undefined); };
				resources.add(picker.onDidAccept(item => { resolve(item); controller.abort(); picker.hide(); }));
				resources.add(picker.onDidHide(cancel));
				resources.add(picker.onDidBlur(() => { cancel(); picker.hide(); }));
				resources.add(workspace.onDidChangeWorkspace(() => { cancel(); picker.hide(); }));
				picker.show();
				void (async () => {
					const configured = await debug.refresh();
					throwIfCancelled(controller.signal);
					const dynamic = await Promise.all(workspace.getWorkspace().folders.map(async folder => {
						const configurations = await debug.provideDebugConfigurations(folder.uri, controller.signal, DebugConfigurationProviderTriggerKind.Dynamic);
						return configurations.map(configuration => ({ kind: 'dynamic' as const, label: configuration.name, description: folder.name, detail: configuration.type, folder: folder.uri, configuration }));
					}));
					throwIfCancelled(controller.signal);
					picker.items = [
						...configured.map(configuration => ({ kind: 'configured' as const, label: configuration.name, description: configuration.workspaceFolderName, detail: configuration.type, configuration })),
						...debug.compounds.map(compound => ({ kind: 'compound' as const, label: compound.name, description: compound.workspaceFolderName, compound })),
						...dynamic.flat(),
					];
					picker.busy = false;
				})().catch(error => { controller.abort(); reject(error); picker.hide(); });
			});
		} catch (error) { if (isCancellationError(error)) return; throw error; }
		if (selected?.kind === 'configured') await debug.start(selected.configuration);
		else if (selected?.kind === 'compound') await debug.startCompound(selected.compound);
		else if (selected?.kind === 'dynamic') await debug.startDynamicDebugging(selected.folder, selected.configuration);
	}
});

registerAction2(class StopDebugAction extends Action2 {
	constructor() { super({ id: STOP_DEBUG_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.StopDebugAction' }, "Stop Debugging"), f1: true, precondition: AppServerAvailableContext.isEqualTo(true), keybinding: { primary: Keybinding.single(logicalKey("F5", { shiftKey: true })) }, menu: { id: MenuId.MenubarRunMenu, group: "1_debug", order: 2 } }); }
	override run(accessor: ServicesAccessor): void { void accessor.get(IDebugService).stop().catch(reportError); }
});

registerAction2(class RestartDebugAction extends Action2 {
	constructor() { super({ id: RESTART_DEBUG_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.RestartDebugAction' }, "Restart Debugging"), f1: true, precondition: AppServerAvailableContext.isEqualTo(true), keybinding: { primary: Keybinding.single(logicalKey("F5", { ctrlKey: true, shiftKey: true })) }, menu: { id: MenuId.MenubarRunMenu, group: "1_debug", order: 3 } }); }
	override run(accessor: ServicesAccessor): void { void accessor.get(IDebugService).restart().catch(reportError); }
});

registerAction2(class StopAllDebugAction extends Action2 {
	constructor() { super({ id: STOP_ALL_DEBUG_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.StopAllDebugAction' }, "Stop All Debugging"), f1: true, precondition: AppServerAvailableContext.isEqualTo(true), menu: { id: MenuId.MenubarRunMenu, group: "1_debug", order: 4 } }); }
	override run(accessor: ServicesAccessor): void { void accessor.get(IDebugService).stopAll().catch(reportError); }
});

registerAction2(class FocusDebugConsoleAction extends Action2 {
	constructor() { super({ id: FOCUS_DEBUG_CONSOLE_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.FocusDebugConsoleAction' }, "Focus on Debug Console View"), f1: true }); }
	override run(accessor: ServicesAccessor): Promise<boolean> { return accessor.get(IViewsService).focusView(DEBUG_CONSOLE_VIEW_ID); }
});

registerAction2(class ClearDebugConsoleAction extends Action2 {
	constructor() { super({ id: CLEAR_DEBUG_CONSOLE_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.ClearDebugConsoleAction' }, "Clear Console"), f1: true }); }
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
		constructor() { super({ id, title, f1: true, precondition: AppServerAvailableContext.isEqualTo(true), ...(keybinding ? { keybinding: { primary: keybinding, ...(operation === 'pause' ? { when: CONTEXT_DEBUG_STATE.isEqualTo('running') } : {}) } } : {}) }); }
		override run(accessor: ServicesAccessor): void {
			const session = accessor.get(IDebugService).session;
			if (!session) return;
			if (operation === 'stepOver' || operation === 'stepInto' || operation === 'stepOut') {
				const pane = accessor.get(IEditorPartsService).activePane?.getControl?.();
				if (pane instanceof DisassemblyView) { void pane.step(operation); return; }
			}
			void session[operation]().catch(reportError);
		}
	});
}

function reportError(error: unknown): void { console.error("Debug command failed", error); }
