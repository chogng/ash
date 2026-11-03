import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../agentHost/browser/disconnectedAppServer.js';
import { Schemas } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';
import { canceled } from '../../../base/common/errors.js';
import { createSshRemoteWorkspaceUri } from '../../remote/common/remote.js';
import type { IInstructionService, InstructionImportItem } from '../common/instructionService.js';

export function createAppServerInstructionService(connection: AppServerProtocolClient, remoteHost?: string | { readonly authority: string; }): IInstructionService {
	const resource = (path: string): URI => typeof remoteHost === 'string' ? createSshRemoteWorkspaceUri(remoteHost, path)
		: remoteHost ? URI.from({ scheme: Schemas.ashRemote, authority: remoteHost.authority, path }) : URI.file(path);
	return {
		isAvailable: true,
		captureImports(sessionId) {
			const generation = connection.generation;
			const assertCurrent = (): void => { if (generation !== connection.generation) throw canceled(); };
			return {
				async directories(scope) {
					assertCurrent();
					const [result, session] = await Promise.all([
						appServerRequest(connection, 'session/dirs/list', { sessionId }),
						appServerRequest(connection, 'session/read', { sessionId }),
					]);
					assertCurrent();
					// The primary execution directory is separate from additional Session grants.
					// Preview rechecks its current read/browse authority before discovering files.
					const paths = new Set(result.dirs.map(directory => directory.path));
					if (session.session.executionTarget) paths.add(session.session.executionTarget.root);
					const required = scope === 'user' ? ['readFiles', 'browseFiles'] : ['readFiles', 'browseFiles', 'writeFiles'];
					return [...paths].map(path => {
						const permissions = result.dirs.find(directory => directory.path === path)?.permissions;
						return { path, resource: resource(path), needsAccess: !required.every(permission => permissions?.some(existing => existing === permission)) };
					});
				},
				async grantAccess(path) {
					assertCurrent();
					const current = await appServerRequest(connection, 'session/dirs/list', { sessionId });
					assertCurrent();
					const existing = current.dirs.find(directory => directory.path === path);
					const permissions = new Set(existing?.permissions ?? []);
					permissions.add('readFiles'); permissions.add('browseFiles'); permissions.add('writeFiles');
					if (existing) {
						await appServerRequest(connection, 'session/directoryGrants/set', { sessionId, path, expectedRevision: current.revision, permissions: [...permissions] });
					} else {
						await appServerRequest(connection, 'session/dirs/add', { sessionId, path, permissions: [...permissions] });
					}
					assertCurrent();
				},
				async preview(selection) {
					assertCurrent();
					const result = await appServerRequest(connection, 'instructions/importPreview', { scope: selection.scope ?? 'directory', source: selection.source, directory: { sessionId, path: selection.directory }, sources: [...selection.sources] });
					assertCurrent();
					return { targetDirectory: resource(result.targetDirectory), digest: result.digest, items: result.items.map(importItem), diagnostics: result.diagnostics.map(diagnostic => ({ path: diagnostic.path, message: diagnostic.message })) };
				},
				async apply(selection, digest) {
					assertCurrent();
					const result = await appServerRequest(connection, 'instructions/import', { scope: selection.scope ?? 'directory', source: selection.source, directory: { sessionId, path: selection.directory }, sources: [...selection.sources], digest });
					assertCurrent();
					return result.items.map(importItem);
				},
			};
		},
		list: async sessionId => (await appServerRequest(connection, 'instructions/list', sessionId ? { sessionId } : {})).instructions.map(instruction => ({
			path: instruction.path,
			resource: resource(instruction.path),
			name: instruction.name,
			description: instruction.description ?? undefined,
			scope: instruction.scope,
		})),
	};
}

export function createDisconnectedInstructionService(unavailable: UnavailableOperation): IInstructionService {
	return { isAvailable: false, list: () => unavailable('instructions/list') };
}

function importItem(item: { readonly source: string; readonly target: string; readonly content: string; readonly status: InstructionImportItem['status']; readonly message: string | null; }): InstructionImportItem {
	return { source: item.source, target: item.target, content: item.content, status: item.status, ...(item.message === null ? {} : { message: item.message }) };
}
