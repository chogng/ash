import type { URI } from '../../../../base/common/uri.js';
import type { INativeHostApi } from '../../../../platform/native/common/nativeHost.js';
import type { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

/** Reveals local file resources, or the first workspace folder when no file is selected. */
export async function revealResourcesInOS(
	resources: readonly URI[],
	nativeHostService: INativeHostApi,
	workspaceContextService: IWorkspaceContextService,
): Promise<void> {
	const targets = resources.length > 0 ? resources : workspaceContextService.getWorkspace().folders.map(folder => folder.uri).slice(0, 1);
	for (const resource of targets) {
		if (resource.scheme === 'file' && !resource.authority) {
			await nativeHostService.revealFile(resource.fsPath);
		}
	}
}
