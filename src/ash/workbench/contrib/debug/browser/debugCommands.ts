import { IDebugVisualizerService } from '../common/debugVisualizers.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import type { IDebugVariable } from '../common/debug.js';
import { memoryResource } from './debugMemory.js';
import { showLoadedScriptMenu } from '../common/loadedScriptsPicker.js';
import { BreakpointsView } from './breakpointsView.js';
import { WorkbenchViewContainerId } from '../../../common/views.js';
import { IEditorPartsService } from '../../../browser/parts/editor/editorParts.js';
import { DisassemblyView } from './disassemblyView.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService, type IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { FileNotFoundError, FileSystemProviderErrorCode, toFileSystemProviderErrorCode, IFileService } from '../../../../platform/files/common/files.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IDebugService, START_DEBUG_COMMAND_ID, SELECT_AND_START_ID, DebugConfigurationProviderTriggerKind, type DebugConfiguration, type IDebugConfiguration, type IDebugCompound, type IDataBreakpointOptions, VARIABLES_VIEW_ID, WATCH_VIEW_ID, CALLSTACK_VIEW_ID, BREAKPOINTS_VIEW_ID } from '../common/debug.js';
import { CONTEXT_DEBUG_STATE, CONTINUE_DEBUG_COMMAND_ID, PAUSE_DEBUG_COMMAND_ID, RESTART_DEBUG_COMMAND_ID, STOP_ALL_DEBUG_COMMAND_ID, STOP_DEBUG_COMMAND_ID } from '../common/debug.js';
import { CLEAR_DEBUG_CONSOLE_COMMAND_ID, DEBUG_CONSOLE_VIEW_ID, FOCUS_DEBUG_CONSOLE_COMMAND_ID, STEP_INTO_DEBUG_COMMAND_ID, STEP_OUT_DEBUG_COMMAND_ID, STEP_OVER_DEBUG_COMMAND_ID } from '../common/debug.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { PICK_WORKSPACE_FOLDER_COMMAND_ID } from '../../../browser/actions/workspaceCommands.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { AppServerAvailableContext } from '../../../common/contextkeys.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';

export const DEBUG_QUICK_ACCESS_PREFIX = 'debug ';
export const DEBUG_CONSOLE_QUICK_ACCESS_PREFIX = 'debug consoles ';

registerAction2(class SelectDebugConsoleAction extends Action2 {
	constructor() { super({ id: 'workbench.action.debug.selectDebugConsole', title: localize2('debug.consoleQuickAccess', 'Debug: Select Console'), f1: true }); }
	override run(accessor: ServicesAccessor): void { accessor.get(IQuickInputService).quickAccess.show(DEBUG_CONSOLE_QUICK_ACCESS_PREFIX); }
});

registerAction2(class StartDebugAction extends Action2 {
	constructor() {
		super({
			id: START_DEBUG_COMMAND_ID, title: localize2('debug.start', 'Start Debugging'), f1: true,
			precondition: AppServerAvailableContext.isEqualTo(true), keybinding: { primary: Keybinding.single(logicalKey('F5')) },
			menu: { id: MenuId.MenubarRunMenu, group: '1_debug', order: 1 }
		});
	}

	public override async run(accessor: ServicesAccessor, startNew = false): Promise<void> {
		if (typeof startNew !== 'boolean') throw new CancellationError();
		const debug = accessor.get(IDebugService);
		await accessor.get(IViewsService).openViewContainer(WorkbenchViewContainerId.Debug, true);
		if (!startNew && debug.session?.state === 'stopped') {
			await debug.session.continue();
			return;
		}
		await debug.refresh();
		const selected = debug.getConfigurationManager().selectedConfiguration;
		if (!selected) throw new Error(localize('debug.noConfiguration', 'No debug configuration found in .vscode/launch.json'));
		if ('configurations' in selected) await debug.startCompound(selected);
		else await debug.start(selected);
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
				resources.add(picker.onDidAccept(() => {
					const item = picker.selectedItems[0];
					if (!item) return;
					resolve(item); controller.abort(); picker.hide();
				}));
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
		if (selected?.kind === 'configured') {
			await debug.getConfigurationManager().selectConfiguration(selected.configuration);
			await debug.start(selected.configuration);
		}
		else if (selected?.kind === 'compound') {
			await debug.getConfigurationManager().selectConfiguration(selected.compound);
			await debug.startCompound(selected.compound);
		}
		else if (selected?.kind === 'dynamic') await debug.startDynamicDebugging(selected.folder, selected.configuration);
	}
});

export const DEBUG_CONFIGURE_COMMAND_ID = 'workbench.action.debug.configure';

registerAction2(class ConfigureDebugAction extends Action2 {
	constructor() {
		super({ id: DEBUG_CONFIGURE_COMMAND_ID, title: localize2('debug.configure', 'Open launch.json'), f1: true });
	}

	public override async run(accessor: ServicesAccessor, selectedFolder?: URI, preserveFocus = false, signal?: AbortSignal): Promise<void> {
		const workspace = accessor.get(IWorkspaceContextService);
		const editor = accessor.get(IEditorService);
		if (selectedFolder !== undefined && !URI.isUri(selectedFolder) || typeof preserveFocus !== 'boolean') throw new CancellationError();
		const activeResource = editor.activeEditor?.resource;
		const selected = accessor.get(IDebugService).getConfigurationManager().selectedConfiguration;
		const folders = workspace.getWorkspace().folders;
		const folder = selectedFolder === undefined
			? folders.find(folder => folder.id === selected?.dirId)
			?? (activeResource ? workspace.getWorkspaceFolder(activeResource) : null)
			?? (folders.length === 1 ? folders[0] : folders.length ? await accessor.get(ICommandService).executeCommand<IWorkspaceFolder | undefined>(PICK_WORKSPACE_FOLDER_COMMAND_ID, [{ placeHolder: localize('debug.selectFolder', 'Select a workspace folder to configure debugging.') }]) : undefined)
			: workspace.getWorkspace().folders.find(folder => folder.uri.toString() === selectedFolder.toString());
		if (selectedFolder && !folder) throw new CancellationError();
		if (!folder) {
			if (!folders.length) await accessor.get(IFileDialogService).pickFolderAndOpen();
			return;
		}
		const files = accessor.get(IFileService);
		const debug = accessor.get(IDebugService);
		using lifetime = new DisposableStore();
		const controller = new AbortController();
		const abort = (): void => controller.abort();
		lifetime.add(toDisposable(abort));
		lifetime.add(workspace.onDidChangeWorkspace(abort));
		signal?.addEventListener('abort', abort, { once: true });
		lifetime.add(toDisposable(() => signal?.removeEventListener('abort', abort)));
		if (signal?.aborted) abort();
		throwIfCancelled(controller.signal);
		const resource = URI.joinPath(folder.uri, '.vscode', 'launch.json');
		try {
			await files.stat(resource);
		} catch (error) {
			if (!(error instanceof FileNotFoundError)) throw error;
			throwIfCancelled(controller.signal);
			const configurations = await debug.provideDebugConfigurations(folder.uri, controller.signal);
			throwIfCancelled(controller.signal);
			await files.createDirectory(URI.joinPath(folder.uri, '.vscode'));
			throwIfCancelled(controller.signal);
			try {
				// Another editor or window may create this file while templates are pending.
				await files.writeFileBytes(resource, new TextEncoder().encode(JSON.stringify({ version: '0.2.0', configurations }, null, '\t') + '\n'), { create: true, overwrite: false }, controller.signal);
			} catch (writeError) {
				if (!(writeError instanceof Error) || toFileSystemProviderErrorCode(writeError) !== FileSystemProviderErrorCode.FileExists) throw writeError;
			}
		}
		throwIfCancelled(controller.signal);
		await editor.openEditor({ resource }, { pinned: true, ignoreError: true, preserveFocus });
	}
});

registerAction2(class StopDebugAction extends Action2 {
	constructor() { super({ id: STOP_DEBUG_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.StopDebugAction' }, 'Stop Debugging'), f1: true, precondition: AppServerAvailableContext.isEqualTo(true), keybinding: { primary: Keybinding.single(logicalKey('F5', { shiftKey: true })) }, menu: { id: MenuId.MenubarRunMenu, group: '1_debug', order: 2 } }); }
	override run(accessor: ServicesAccessor): void { void accessor.get(IDebugService).stop().catch(reportError); }
});

registerAction2(class RestartDebugAction extends Action2 {
	constructor() { super({ id: RESTART_DEBUG_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.RestartDebugAction' }, 'Restart Debugging'), f1: true, precondition: AppServerAvailableContext.isEqualTo(true), keybinding: { primary: Keybinding.single(logicalKey('F5', { ctrlKey: true, shiftKey: true })) }, menu: { id: MenuId.MenubarRunMenu, group: '1_debug', order: 3 } }); }
	override run(accessor: ServicesAccessor): void { void accessor.get(IDebugService).restart().catch(reportError); }
});

registerAction2(class StopAllDebugAction extends Action2 {
	constructor() { super({ id: STOP_ALL_DEBUG_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.StopAllDebugAction' }, 'Stop All Debugging'), f1: true, precondition: AppServerAvailableContext.isEqualTo(true), menu: { id: MenuId.MenubarRunMenu, group: '1_debug', order: 4 } }); }
	override run(accessor: ServicesAccessor): void { void accessor.get(IDebugService).stopAll().catch(reportError); }
});

registerAction2(class FocusDebugConsoleAction extends Action2 {
	constructor() { super({ id: FOCUS_DEBUG_CONSOLE_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.FocusDebugConsoleAction' }, 'Focus on Debug Console View'), f1: true }); }
	override run(accessor: ServicesAccessor): Promise<boolean> { return accessor.get(IViewsService).focusView(DEBUG_CONSOLE_VIEW_ID); }
});

registerAction2(class ClearDebugConsoleAction extends Action2 {
	constructor() { super({ id: CLEAR_DEBUG_CONSOLE_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.ClearDebugConsoleAction' }, 'Clear Console'), f1: true }); }
	override run(accessor: ServicesAccessor): void | Promise<void> { return accessor.get(IDebugService).replModel.clear(); }
});

for (const [id, title, keybinding, operation] of [
	[CONTINUE_DEBUG_COMMAND_ID, localize2('debug.continue', 'Continue'), undefined, 'continue'],
	[PAUSE_DEBUG_COMMAND_ID, localize2('debug.pause', 'Pause'), Keybinding.single(logicalKey('F6')), 'pause'],
	[STEP_OVER_DEBUG_COMMAND_ID, localize2('debug.stepOver', 'Step Over'), Keybinding.single(logicalKey('F10')), 'stepOver'],
	[STEP_INTO_DEBUG_COMMAND_ID, localize2('debug.stepInto', 'Step Into'), Keybinding.single(logicalKey('F11')), 'stepInto'],
	[STEP_OUT_DEBUG_COMMAND_ID, localize2('debug.stepOut', 'Step Out'), Keybinding.single(logicalKey('F11', { shiftKey: true })), 'stepOut'],
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

function reportError(error: unknown): void { console.error('Debug command failed', error); }

export const ADD_DATA_BREAKPOINT_ID = 'debug.addDataBreakpoint';
export const ADD_INSTRUCTION_BREAKPOINT_ID = 'debug.addInstructionBreakpoint';

registerAction2(class extends Action2 {
	constructor() { super({ id: ADD_DATA_BREAKPOINT_ID, title: localize2('debug.addDataBreakpoint', 'Add Data Breakpoint') }); }
	override async run(accessor: ServicesAccessor, options: IDataBreakpointOptions): Promise<void> {
		const debug = accessor.get(IDebugService);
		const session = debug.session;
		if (!options || typeof options.dataId !== 'string' || typeof options.description !== 'string'
			|| !Array.isArray(options.accessTypes) || !options.accessTypes.every(type => ['read', 'write', 'readWrite'].includes(type))
			|| !options.accessTypes.includes(options.accessType) || typeof options.canPersist !== 'boolean'
			|| !session || session.state !== 'stopped' || !session.capabilities.supportsDataBreakpoints || options.sessionId !== session.id) throw new CancellationError();
		const frame = debug.getViewModel().focusedStackFrame;
		await accessor.get(IViewsService).openViewContainer(WorkbenchViewContainerId.Debug);
		const view = await accessor.get(IViewsService).openView<BreakpointsView>(BREAKPOINTS_VIEW_ID, true);
		if (view && debug.session === session && session.state === 'stopped' && debug.getViewModel().focusedStackFrame === frame) view.renderInputBox({ kind: 'data', options });
	}
});

registerAction2(class extends Action2 {
	constructor() { super({ id: ADD_INSTRUCTION_BREAKPOINT_ID, title: localize2('debug.addInstructionBreakpoint', 'Add Instruction Breakpoint') }); }
	override async run(accessor: ServicesAccessor, instructionReference: string): Promise<void> {
		if (typeof instructionReference !== 'string') throw new CancellationError();
		const debug = accessor.get(IDebugService);
		const session = debug.session;
		if (!session || session.state !== 'stopped' || !session.capabilities.supportsInstructionBreakpoints) throw new CancellationError();
		const frame = debug.getViewModel().focusedStackFrame;
		await accessor.get(IViewsService).openViewContainer(WorkbenchViewContainerId.Debug);
		const view = await accessor.get(IViewsService).openView<BreakpointsView>(BREAKPOINTS_VIEW_ID, true);
		if (view && debug.session === session && session.state === 'stopped' && debug.getViewModel().focusedStackFrame === frame) view.renderInputBox({ kind: 'instruction', instructionReference });
	}
});

for (const [id, view, title] of [
	['workbench.debug.action.focusVariablesView', VARIABLES_VIEW_ID, localize2('debug.variables', 'Variables')],
	['workbench.debug.action.focusWatchView', WATCH_VIEW_ID, localize2('debug.watch', 'Watch')],
	['workbench.debug.action.focusCallStackView', CALLSTACK_VIEW_ID, localize2('debug.callStack', 'Call Stack')],
	['workbench.debug.action.focusBreakpointsView', BREAKPOINTS_VIEW_ID, localize2('debug.breakpoints', 'Breakpoints')],
] as const) {
	registerAction2(class extends Action2 {
		constructor() { super({ id, title, f1: true }); }
		override async run(accessor: ServicesAccessor): Promise<boolean> {
			const views = accessor.get(IViewsService);
			await views.openViewContainer(WorkbenchViewContainerId.Debug);
			return views.focusView(view);
		}
	});
}

registerAction2(class OpenLoadedScriptAction extends Action2 {
	constructor() { super({ id: 'workbench.action.debug.showLoadedScripts', title: localize2('debug.showLoadedScript', 'Debug: Open Loaded Script'), f1: true }); }
	override async run(accessor: ServicesAccessor): Promise<void> { await showLoadedScriptMenu(accessor); }
});

registerAction2(class OpenDebugMemoryAction extends Action2 {
	constructor() { super({ id: 'workbench.action.debug.viewMemory', title: localize2('debug.viewMemory', 'Debug: View Memory'), f1: true }); }
	override async run(accessor: ServicesAccessor, sessionId?: string, reference?: string): Promise<void> {
		const debug = accessor.get(IDebugService);
		const session = sessionId === undefined ? debug.session : typeof sessionId === 'string' ? debug.getSession(sessionId) : undefined;
		if (!session || session.state !== 'stopped' || !session.capabilities.supportsReadMemoryRequest) throw new Error(localize('debug.memoryUnavailable', 'Pause a debug adapter that supports this memory operation first.'));
		if (reference !== undefined && typeof reference !== 'string') throw new CancellationError();
		const revision = session.inspectionRevision;
		reference ??= await accessor.get(IQuickInputService).input({ placeHolder: localize('debug.memoryReference', 'Memory reference or address') });
		if (!reference) return;
		const countText = await accessor.get(IQuickInputService).input({ placeHolder: localize('debug.memoryCount', 'Byte count (1–4096)'), value: '256' });
		if (countText === undefined) return;
		const count = Number(countText);
		if (!Number.isSafeInteger(count) || count < 1 || count > 4096) throw new RangeError(localize('debug.invalidMemoryRange', 'A memory request requires a reference and between 1 and 4096 bytes.'));
		if (debug.getSession(session.id) !== session || session.state !== 'stopped' || session.inspectionRevision !== revision) return;
		await accessor.get(IEditorService).openEditor({ resource: memoryResource(session.id, revision, reference, 0, count), label: localize('debug.memoryLabel', 'Memory: {0}', reference), encoding: 'utf8', languageId: 'plaintext', readOnly: !session.capabilities.supportsWriteMemoryRequest }, { pinned: true });
	}
});

registerAction2(class VisualizeVariableAction extends Action2 {
	constructor() { super({ id: 'workbench.action.debug.visualizeVariable', title: localize2('debug.visualizeVariable', 'Debug: Visualize Variable'), f1: true }); }
	override async run(accessor: ServicesAccessor): Promise<void> {
		const debug = accessor.get(IDebugService);
		const session = debug.session;
		const frame = debug.getViewModel().focusedStackFrame;
		if (!session || session.state !== 'stopped' || !frame) return;
		const revision = session.inspectionRevision;
		const current = () => debug.session === session && session.state === 'stopped' && session.inspectionRevision === revision && debug.getViewModel().focusedStackFrame === frame;
		const scopes = await session.inspectFrame(frame.id, 'all');
		if (!current()) return;
		const quickInput = accessor.get(IQuickInputService);
		const variable = await pickDebugItem<IQuickPickItem & { variable: IDebugVariable; }>(quickInput, scopes.flatMap(scope => scope.variables.map(variable => ({ label: variable.name, description: scope.scope.name, detail: variable.value.slice(0, 256), variable }))), localize('debug.pickVariable', 'Select a variable to visualize'));
		if (!variable || !current()) return;
		const visualizers = accessor.get(IDebugVisualizerService).getVisualizers(session, variable.variable);
		const selected = await pickDebugItem(quickInput, visualizers.map(visualizer => ({ label: visualizer.name, visualizer })), localize('debug.pickVisualizer', 'Select a debug visualizer'));
		if (!selected || !current()) return;
		using lifetime = new DisposableStore();
		const controller = new AbortController();
		lifetime.add(session.onDidChangeState(() => controller.abort()));
		lifetime.add(debug.getViewModel().onDidFocusStackFrame(() => controller.abort()));
		try {
			const result = await selected.visualizer.visualize(controller.signal);
			if (!current() || controller.signal.aborted) return;
			await accessor.get(IEditorService).openEditor({ resource: URI.from({ scheme: 'untitled', path: `/debug-${generateUuid()}` }), label: `${variable.label}: ${selected.label}`, languageId: result.languageId, initialText: result.content, readOnly: true }, { pinned: true });
		} catch (error) { if (!isCancellationError(error)) throw error; }
	}
});


async function pickDebugItem<T extends IQuickPickItem>(quickInput: IQuickInputService, items: readonly T[], placeholder: string): Promise<T | undefined> {
	using lifetime = new DisposableStore();
	const picker = lifetime.add(quickInput.createQuickPick<T>());
	picker.items = items;
	picker.ariaLabel = picker.placeholder = placeholder;
	return await new Promise<T | undefined>(resolve => {
		lifetime.add(picker.onDidAccept(() => { const item = picker.selectedItems[0]; if (item) { resolve(item); picker.hide(); } }));
		lifetime.add(picker.onDidHide(() => resolve(undefined)));
		lifetime.add(picker.onDidBlur(() => picker.hide()));
		picker.show();
	});
}
