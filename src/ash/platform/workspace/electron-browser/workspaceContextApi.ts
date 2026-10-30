import { invoke, subscribe } from '../../ipc/electron-browser/rendererIpc.js';
import { WORKSPACE_CONTEXT_CHANGED_CHANNEL, WORKSPACE_CONTEXT_READ_CHANNEL, WORKSPACE_EDIT_CHANNEL, type IWorkspaceContextApi } from '../common/workspaceIpc.js';
import { WORKSPACE_CONFIGURATION_CHANNEL, WORKSPACE_CONFIGURATION_CHANGED_CHANNEL } from '../common/workspaceIpc.js';
import { FileKind, FileNotFoundError, FileRevisionConflictError, type IFileWriteResult } from '../../files/common/files.js';
import type { URI } from '../../../base/common/uri.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { CancellationError } from '../../../base/common/errors.js';

function configurationResult(resource: URI, value: unknown): IFileWriteResult {
	if (!value || typeof value !== 'object') throw new TypeError('Invalid workspace configuration response');
	const result = value as Record<string, unknown>;
	if (result.error === 'notCurrent') throw new CancellationError('The workspace configuration is no longer current');
	if (result.error === 'revisionConflict') throw new FileRevisionConflictError(resource);
	if (result.error === 'notFound') throw new FileNotFoundError(resource);
	if (typeof result.revision !== 'string' || !Number.isSafeInteger(result.sizeBytes) || (result.sizeBytes as number) < 0
		|| typeof result.readonly !== 'boolean' || typeof result.modifiedAtMillis !== 'number') throw new TypeError('Invalid workspace configuration response');
	return { revision: result.revision, stat: { resource, kind: FileKind.File, sizeBytes: result.sizeBytes as number, readonly: result.readonly, modifiedAtMillis: result.modifiedAtMillis } };
}

export function createWorkspaceContextApi(): IWorkspaceContextApi & { validateFolders(folders: readonly URI[]): void; } {
	const validators = new Set<(event: { readonly folders: readonly URI[]; veto(reason: Error): void; }) => void>();
	return {
		onWillChangeFolders: listener => { validators.add(listener); return toDisposable(() => validators.delete(listener)); },
		validateFolders: folders => {
			let failure: Error | undefined;
			for (const listener of validators) listener({ folders, veto: reason => { failure ??= reason; } });
			if (failure) throw failure;
		},
		configurationFiles: {
			onDidChange: listener => {
				const subscription = subscribe(WORKSPACE_CONFIGURATION_CHANGED_CHANNEL, () => listener());
				return toDisposable(() => subscription.dispose());
			},
			read: async resource => {
				const value = await invoke<unknown>(WORKSPACE_CONFIGURATION_CHANNEL, { operation: 'read', uri: resource.toString() });
				const result = configurationResult(resource, value);
				const content = (value as Record<string, unknown>).content;
				if (typeof content !== 'string') throw new TypeError('Invalid workspace configuration content');
				return { resource, bytes: new TextEncoder().encode(content), ...result };
			},
			write: async (resource, content, options) => configurationResult(resource, await invoke(WORKSPACE_CONFIGURATION_CHANNEL, { operation: 'write', uri: resource.toString(), content: new TextDecoder('utf-8', { fatal: true }).decode(content), options: { create: options.create, overwrite: options.overwrite, ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }) } })),
		},
		getWorkspace: () => invoke(WORKSPACE_CONTEXT_READ_CHANNEL),
		editWorkspace: request => invoke(WORKSPACE_EDIT_CHANNEL, request),
		onDidChange: (listener) => subscribe(WORKSPACE_CONTEXT_CHANGED_CHANNEL, listener),
	};
}
