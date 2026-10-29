import type { SessionCreateParams } from '../../platform/agentHost/common/agent.js';
import { createSshRemoteAuthority } from '../../platform/remote/common/remote.js';
import type { ISessionWorkspace } from '../services/sessions/common/session.js';

/** An absent directory and a directory on another authority must never share a cache entry. */
export function agentHostSessionWorkspaceKey(workspace: ISessionWorkspace | null | undefined): string | undefined {
	return workspace ? JSON.stringify([workspace.authorityId, workspace.root]) : undefined;
}

export function buildAgentHostSessionWorkspace(target: SessionCreateParams['executionTarget'] | undefined): ISessionWorkspace | null {
	if (!target) {
		return null;
	}
	// Keep SSH aliases distinct from the local sentinel and opaque provider authorities.
	const authorityId =
		target.type === 'local'
			? 'local'
			: target.type === 'ssh'
				? createSshRemoteAuthority(target.host).authority
				: `provider+${encodeURIComponent(JSON.stringify([target.providerId, target.workspace]))}`;
	return Object.freeze({
		authorityId,
		root: target.root,
		...(target.type === 'provider' ? { runtime: Object.freeze({ providerId: target.providerId, workspace: target.workspace }) } : {}),
	});
}

/** Undefined means not hydrated; null is a hydrated Thread without filesystem access. */
export function buildAgentHostChatWorkspace(directory: SessionCreateParams['executionTarget'] | undefined): ISessionWorkspace | null | undefined {
	return directory === undefined ? undefined : buildAgentHostSessionWorkspace(directory);
}
