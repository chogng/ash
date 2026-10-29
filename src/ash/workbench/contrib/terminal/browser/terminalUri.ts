import { URI } from '../../../../base/common/uri.js';

const scheme = 'vscode-terminal';

/** Resource identity is window-local; it never authorizes reopening a process. */
export function getTerminalUri(workspaceId: string, instanceId: number, title?: string, commandId?: string): URI {
	return URI.from({ scheme, path: `/${workspaceId}/${instanceId}`, fragment: title, query: commandId });
}

/** Validate external resources before looking up a live terminal. */
export function parseTerminalUri(resource: URI): { workspaceId: string; instanceId: number } {
	const match = /^\/([^/]+)\/([1-9][0-9]*)$/.exec(resource.path);
	const instanceId = Number(match?.[2]);
	if (resource.scheme !== scheme || resource.authority || !match || !Number.isSafeInteger(instanceId)) {
		throw new TypeError('Invalid terminal resource');
	}
	return { workspaceId: match[1]!, instanceId };
}

export function getInstanceFromResource<T extends { readonly resource?: URI }>(
	instances: readonly T[],
	resource: URI | undefined,
): T | undefined {
	if (!resource) return undefined;
	parseTerminalUri(resource);
	return instances.find(
		instance => instance.resource?.scheme === resource.scheme && instance.resource.path === resource.path,
	);
}
