import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { FileNotFoundError, FileSystemProviderErrorCode, toFileSystemProviderErrorCode, IFileService } from '../../../../platform/files/common/files.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkspaceOpenService } from '../../../services/workspaces/browser/workspaceOpenService.js';
import { IDebugService } from '../../../services/debug/common/debugService.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { localize2 } from '../../../../nls.js';

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
		const folder = selectedFolder === undefined
			? (activeResource ? workspace.getWorkspaceFolder(activeResource) : null) ?? workspace.getWorkspace().folders[0]
			: workspace.getWorkspace().folders.find(folder => folder.uri.toString() === selectedFolder.toString());
		if (selectedFolder && !folder) throw new CancellationError();
		if (!folder) {
			await accessor.get(IWorkspaceOpenService).openFolder();
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
