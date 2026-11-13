import { URI } from '../../../base/common/uri.js';
import { isUuid } from '../../../base/common/uuid.js';
import { getWorkspaceRemoteAuthority, parseWorkspaceIdentifier, type IAnyWorkspaceIdentifier, type IWorkspace } from '../../workspace/common/workspace.js';

export type ArtifactIdentity = { readonly type: 'canvas' | 'table'; readonly id: string; };

export interface ArtifactLink {
	readonly identity: ArtifactIdentity;
	readonly workspace: IAnyWorkspaceIdentifier;
}

export function parseArtifactKey(key: string): ArtifactIdentity | undefined {
	const [type, id, extra] = key.split(':');
	return extra === undefined && (type === 'canvas' || type === 'table') && isUuid(id) ? { type, id } : undefined;
}

export function buildArtifactLink(identity: ArtifactIdentity, workspace: IWorkspace): URI {
	const { id, configuration, folders } = workspace;
	const url = new URL(`ash://artifact/open/${identity.type}/${identity.id}`);
	url.searchParams.set('workspace', id);
	if (!configuration && folders.length === 1) {
		url.searchParams.set('folder', folders[0].uri.toString());
	} else {
		if (configuration) url.searchParams.set('config', configuration.toString());
		const remoteAuthority = getWorkspaceRemoteAuthority(workspace);
		if (remoteAuthority) url.searchParams.set('remote', remoteAuthority);
	}
	return URI.parse(url.href);
}

export function isArtifactLink(resource: URI): boolean {
	return resource.scheme === 'ash' && resource.authority === 'artifact'
		|| resource.scheme === 'ash-artifact' && resource.authority === 'open';
}

/** Validates the link before it can select a workspace or address a saved artifact. */
export function parseArtifactLink(resource: URI): ArtifactLink | undefined {
	if (!isArtifactLink(resource) || resource.fragment || resource.query.length > 32768) return undefined;
	try {
		const legacy = resource.scheme === 'ash-artifact';
		const path = (legacy ? /^\/(canvas|table)\/([^/]+)$/u : /^\/open\/(canvas|table)\/([^/]+)$/u).exec(resource.path);
		const identity = path && parseArtifactKey(`${path[1]}:${path[2]}`);
		if (!identity) return undefined;
		const query = new URLSearchParams(resource.toEncodedComponents().query);
		const id = query.get('workspace');
		if (!id) return undefined;
		const keys = [...query.keys()];
		if (new Set(keys).size !== keys.length || keys.some(key => !['workspace', 'folder', 'config', 'remote'].includes(key))) return undefined;
		if (keys.length === 1 && (legacy || id.startsWith('%7B'))) {
			// Previously copied links encoded a JSON workspace inside the URI query.
			return { identity, workspace: parseWorkspaceIdentifier(legacy ? { id } : JSON.parse(decodeURIComponent(id))) };
		}
		if (legacy) return undefined;
		const folder = query.get('folder');
		const config = query.get('config');
		const remote = query.get('remote');
		if (folder !== null && (config !== null || remote !== null)) return undefined;
		const workspace = {
			id,
			...(folder === null ? {} : { uri: folder }),
			...(config === null ? {} : { configPath: config }),
			...(remote === null ? {} : { remoteAuthority: remote }),
		};
		return { identity, workspace: parseWorkspaceIdentifier(workspace) };
	} catch {
		return undefined;
	}
}
