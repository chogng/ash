import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService, type IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { FileNotFoundError, FileSystemProviderErrorCode, toFileSystemProviderErrorCode, IFileService } from '../../../../platform/files/common/files.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { DEBUG_VIEW_ID, IDebugService, START_DEBUG_COMMAND_ID, SELECT_AND_START_ID, DebugConfigurationProviderTriggerKind, type DebugConfiguration, type IDebugConfiguration, type IDebugCompound } from '../common/debug.js';
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
		await accessor.get(IViewsService).focusView(DEBUG_VIEW_ID);
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
