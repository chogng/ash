import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { workspaceRelativePath } from '../../../../platform/files/browser/fileService.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { getRemoteWorkspacePath, isRemoteResource } from '../../../../platform/remote/common/remote.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

export async function copyFilePath(accessor: ServicesAccessor, resourceArgument?: unknown): Promise<void> {
	const resource = resolveFileResource(accessor, resourceArgument);
	const path = resource.scheme === 'file' ? resource.fsPath : getRemoteWorkspacePath(resource);
	await accessor.get(IClipboardService).writeText(path);
}

export async function copyRelativeFilePath(accessor: ServicesAccessor, resourceArgument?: unknown): Promise<void> {
	const resource = resolveFileResource(accessor, resourceArgument);
	const folders = accessor.get(IWorkspaceContextService).getWorkspace().folders;
	const folder = folders
		.filter(candidate => extUriBiasedIgnorePathCase.isEqualOrParent(resource, candidate.uri))
		.sort((left, right) => right.uri.path.length - left.uri.path.length)[0];
	if (!folder) {
		throw new Error(localize({ bundle: 'ash', key: 'workbench.copyRelativePathOutsideWorkspace' }, 'The file is outside the current workspace.'));
	}
	await accessor.get(IClipboardService).writeText(workspaceRelativePath(folder.uri, resource));
}

export function resolveFileResource(accessor: ServicesAccessor, resourceArgument: unknown): URI {
	if (resourceArgument !== undefined && !(resourceArgument instanceof URI)) {
		throw new TypeError('File path command requires a resource URI');
	}
	const resource = resourceArgument ?? accessor.get(IEditorService).activeEditor?.resource;
	if (!resource) {
		throw new Error(localize({ bundle: 'ash', key: 'workbench.copyPathNoFile' }, 'Open a file to copy its path.'));
	}
	if (resource.scheme !== 'file' && !isRemoteResource(resource)) {
		throw new Error(localize({ bundle: 'ash', key: 'workbench.copyPathUnsupported' }, 'This editor does not have a file path.'));
	}
	return resource;
}
