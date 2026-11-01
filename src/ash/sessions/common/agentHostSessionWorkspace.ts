import { URI } from '../../base/common/uri.js';
import type { IWorkspace } from '../../platform/workspace/common/workspace.js';
import type { SessionCreateParams } from '../../platform/agentHost/common/agent.js';
import { createProviderRemoteWorkspaceUri, createSshRemoteAuthority, getProviderRemoteWorkspace, getRemoteAuthority, getRemoteWorkspacePath, isRemoteResource } from '../../platform/remote/common/remote.js';
import type { ISessionWorkspace, SessionExecutionTarget, SessionWorkspaceSelection } from '../services/sessions/common/session.js';

/** An absent directory and a directory on another authority must never share a cache entry. */
export function agentHostSessionWorkspaceKey(workspace: ISessionWorkspace | null | undefined): string | undefined {
	return workspace ? JSON.stringify([workspace.authorityId, workspace.root]) : undefined;
}

export function buildAgentHostSessionWorkspace(target: SessionCreateParams['executionTarget'] | undefined): ISessionWorkspace | null {
	if (!target) { return null; }
	// Keep SSH aliases distinct from the local sentinel and opaque provider authorities.
	const authorityId = target.type === 'local' ? 'local' : target.type === 'ssh' ? createSshRemoteAuthority(target.host).authority
		: target.type === 'remote' ? target.authority : createProviderRemoteWorkspaceUri(target.providerId, target.workspace, target.root, target.hostAuthority).authority;
	return Object.freeze({ authorityId, root: target.root, ...(target.type === 'provider' ? { runtime: Object.freeze({ providerId: target.providerId, workspace: target.workspace, ...(target.hostAuthority ? { hostAuthority: target.hostAuthority } : {}) }) } : {}) });
}

/** Undefined means not hydrated; null is a hydrated Thread without filesystem access. */
export function buildAgentHostChatWorkspace(directory: SessionCreateParams['executionTarget'] | undefined): ISessionWorkspace | null | undefined {
	return directory === undefined ? undefined : buildAgentHostSessionWorkspace(directory);
}

export function selectionFromWorkspace(workspace: IWorkspace): SessionWorkspaceSelection {
	if (workspace.folders.length === 0) return { type: 'current' };
	const folders = workspace.folders.map(folder => ({ label: folder.name, target: selectionFromResource(folder.uri) }));
	if (folders.length > 1) return { type: 'multiple', folders };
	return folders[0]!.target;
}

export function selectionFromResource(resource: URI): SessionExecutionTarget {
	if (!isRemoteResource(resource)) return { type: 'local', root: resource.fsPath };
	const runtime = getProviderRemoteWorkspace(resource);
	if (runtime) return { type: 'provider', ...runtime, root: getRemoteWorkspacePath(resource) };
	if (resource.authority.startsWith('wsl+') || resource.authority.startsWith('tunnel+')) return { type: 'remote', authority: resource.authority, root: getRemoteWorkspacePath(resource) };
	const authority = getRemoteAuthority(resource);
	if (!authority) throw new Error('Remote workspace has no SSH authority');
	return { type: 'ssh', host: authority.host, root: getRemoteWorkspacePath(resource) };
}
