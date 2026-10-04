import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import { isWindows } from '../../../../base/common/platform.js';
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
import { EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';

export async function copyFilePath(accessor: ServicesAccessor, resourceArgument?: unknown): Promise<void> {
	const paths = resolveCopyResources(accessor, resourceArgument).map(resource => resource.scheme === Schemas.file ? resource.fsPath : getRemoteWorkspacePath(resource));
	await accessor.get(IClipboardService).writeText(paths.join(isWindows ? '\r\n' : '\n'));
}

export async function copyRelativeFilePath(accessor: ServicesAccessor, resourceArgument?: unknown): Promise<void> {
	const workspace = accessor.get(IWorkspaceContextService);
	const paths = resolveCopyResources(accessor, resourceArgument).map(resource => {
		const folder = workspace.getWorkspaceFolder(resource);
		if (!folder) {
			throw new Error(localize({ bundle: 'ash', key: 'workbench.copyRelativePathOutsideWorkspace' }, 'The file is outside the current workspace.'));
		}
		return workspaceRelativePath(folder.uri, resource);
	});
	await accessor.get(IClipboardService).writeText(paths.join(isWindows ? '\r\n' : '\n'));
}

function resolveCopyResources(accessor: ServicesAccessor, argument: unknown): readonly URI[] {
	if (argument === undefined || argument instanceof URI) return [resolveFileResource(accessor, argument)];
	const context = resolveCommandsContext([argument], accessor.get(IEditorGroupsService));
	if (context.groupedEditors.length === 0) throw new TypeError('File command requires a resource URI or editor context');
	return context.groupedEditors.flatMap(({ editors }) => editors.map(editor => resolveFileResource(accessor, EditorResourceAccessor.getOriginalUri(editor, { supportSideBySide: SideBySideEditor.PRIMARY }))));
}

export function resolveFileResource(accessor: ServicesAccessor, resourceArgument: unknown): URI {
	let resource: URI | undefined;
	if (resourceArgument instanceof URI) {
		resource = resourceArgument;
	} else if (resourceArgument === undefined) {
		resource = EditorResourceAccessor.getOriginalUri(accessor.get(IEditorService).activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY });
	} else {
		resource = EditorResourceAccessor.getOriginalUri(resolveCommandsContext([resourceArgument], accessor.get(IEditorGroupsService)).groupedEditors[0]?.editors[0], { supportSideBySide: SideBySideEditor.PRIMARY });
		if (!resource) throw new TypeError('File command requires a resource URI or editor context');
	}
	if (!resource) {
		throw new Error(localize({ bundle: 'ash', key: 'workbench.copyPathNoFile' }, 'Open a file to copy its path.'));
	}
	if (resource.scheme !== Schemas.file && !isRemoteResource(resource)) {
		throw new Error(localize({ bundle: 'ash', key: 'workbench.copyPathUnsupported' }, 'This editor does not have a file path.'));
	}
	return resource;
}

export async function revealInExplorer(accessor: ServicesAccessor, resourceArgument?: unknown): Promise<void> {
	const resource = resolveFileResource(accessor, resourceArgument);
	if (!accessor.get(IWorkspaceContextService).getWorkspaceFolder(resource)) return;
	const view = await accessor.get(IViewsService).openView(VIEW_ID);
	if (!view) return;
	await accessor.get(IExplorerService).select(resource, 'force');
	view.focus();
}
