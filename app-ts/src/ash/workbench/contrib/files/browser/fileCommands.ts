import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { getRemoteWorkspacePath, isRemoteResource } from '../../../../platform/remote/common/remote.js';
import { IWorkspaceContextService, workspaceRelativePath } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { resolveCommandsContext } from '../../../browser/parts/editor/editorCommandsContext.js';
import { IViewsService } from '../../../services/views/browser/viewsService.js';
import { IExplorerService } from './files.js';
import { VIEW_ID } from '../common/files.js';

export async function copyFilePath(accessor: ServicesAccessor, resourceArgument?: unknown): Promise<void> {
	const resource = resolveFileResource(accessor, resourceArgument);
	const path = resource.scheme === 'file' ? resource.fsPath : getRemoteWorkspacePath(resource);
	await accessor.get(IClipboardService).writeText(path);
}

export async function copyRelativeFilePath(accessor: ServicesAccessor, resourceArgument?: unknown): Promise<void> {
	const resource = resolveFileResource(accessor, resourceArgument);
	const folder = accessor.get(IWorkspaceContextService).getWorkspaceFolder(resource);
	if (!folder) {
		throw new Error(localize({ bundle: 'ash', key: 'workbench.copyRelativePathOutsideWorkspace' }, 'The file is outside the current workspace.'));
	}
	await accessor.get(IClipboardService).writeText(workspaceRelativePath(folder.uri, resource));
}

export function resolveFileResource(accessor: ServicesAccessor, resourceArgument: unknown): URI {
	let resource: URI | undefined;
	if (resourceArgument instanceof URI) {
		resource = resourceArgument;
	} else if (resourceArgument === undefined) {
		resource = accessor.get(IEditorService).activeEditor?.resource;
	} else {
		resource = resolveCommandsContext([resourceArgument], accessor.get(IEditorGroupsService)).groupedEditors[0]?.editors[0]?.resource;
		if (!resource) throw new TypeError('File command requires a resource URI or editor context');
	}
	if (!resource) {
		throw new Error(localize({ bundle: 'ash', key: 'workbench.copyPathNoFile' }, 'Open a file to copy its path.'));
	}
	if (resource.scheme !== 'file' && !isRemoteResource(resource)) {
		throw new Error(localize({ bundle: 'ash', key: 'workbench.copyPathUnsupported' }, 'This editor does not have a file path.'));
	}
	return resource;
}

export async function revealInExplorer(accessor: ServicesAccessor, resourceArgument?: unknown): Promise<void> {
	const resource = resolveFileResource(accessor, resourceArgument);
	if (!accessor.get(IWorkspaceContextService).getWorkspaceFolder(resource)) return;
	const view = accessor.get(IViewsService).openView(VIEW_ID);
	if (!view) return;
	await accessor.get(IExplorerService).select(resource, 'force');
	view.focus();
}
