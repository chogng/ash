import type { URI } from '../../../base/common/uri.js';
import type { Event } from '../../../base/common/event.js';
import type { IFileBytes, IFileWriteOptions, IFileWriteResult, IFileStat } from '../../files/common/files.js';

export const WORKSPACE_CONTEXT_READ_CHANNEL = 'ash:workspace:context:read';
export const WORKSPACE_CONTEXT_CHANGED_CHANNEL = 'ash:workspace:context:changed';
export const WORKSPACE_EDIT_CHANNEL = 'ash:workspace:edit';

export type WorkspaceEditRequest =
	| {
			readonly operation: 'folders';
			readonly index: number;
			readonly deleteCount: number;
			readonly folders: readonly { readonly uri: string; readonly name?: string }[];
	  }
	| { readonly operation: 'save'; readonly path: string };

/** Workspace metadata requests never authorize access to the directories they reference. */
export function validateWorkspaceEdit(value: unknown): WorkspaceEditRequest {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid workspace edit');
	const request = value as Record<string, unknown>;
	if (
		request.operation === 'save' &&
		Object.keys(request).sort().join(',') === 'operation,path' &&
		typeof request.path === 'string' &&
		request.path.length > 0 &&
		request.path.length <= 32768 &&
		!request.path.includes('\0')
	)
		return request as WorkspaceEditRequest;
	if (
		request.operation !== 'folders' ||
		Object.keys(request).sort().join(',') !== 'deleteCount,folders,index,operation' ||
		!Number.isSafeInteger(request.index) ||
		(request.index as number) < 0 ||
		!Number.isSafeInteger(request.deleteCount) ||
		(request.deleteCount as number) < 0 ||
		!Array.isArray(request.folders) ||
		request.folders.length > 256
	)
		throw new TypeError('Invalid workspace edit');
	for (const folder of request.folders) {
		if (
			!folder ||
			typeof folder !== 'object' ||
			Array.isArray(folder) ||
			Object.keys(folder).some(key => key !== 'uri' && key !== 'name') ||
			typeof folder.uri !== 'string' ||
			folder.uri.length > 32768 ||
			folder.uri.includes('\0') ||
			(folder.name !== undefined && (typeof folder.name !== 'string' || !folder.name.trim()))
		)
			throw new TypeError('Invalid workspace folder');
	}
	return request as WorkspaceEditRequest;
}

export interface IWorkspaceContextSubscription {
	dispose(): void;
}

/** Window-owned workspace metadata; directory authorization stays with the backend. */
export interface IWorkspaceContextApi {
	readonly onWillChangeFolders?: Event<{ readonly folders: readonly URI[]; veto(reason: Error): void }>;
	readonly configurationFiles?: IWorkspaceConfigurationFileApi;
	getWorkspace(): Promise<unknown>;
	editWorkspace?(request: WorkspaceEditRequest): Promise<unknown>;
	onDidChange(listener: (workspace: unknown) => void): IWorkspaceContextSubscription;
}

export function validateWorkspaceContextRead(value: unknown): undefined {
	if (value !== undefined) {
		throw new Error('workspace context read does not accept parameters');
	}
	return undefined;
}

export const WORKSPACE_CONFIGURATION_CHANNEL = 'ash:workspace:configuration';
export const WORKSPACE_CONFIGURATION_CHANGED_CHANNEL = 'ash:workspace:configuration:changed';
export const WORKSPACE_EDIT_ERROR_CHANNEL = 'ash:workspace:edit:error';

/** Narrow access to the current workspace file, never its containing directory. */
export interface IWorkspaceConfigurationFileApi {
	readonly onDidChange: Event<void>;
	read(resource: URI): Promise<IFileBytes & { readonly stat: IFileStat }>;
	write(resource: URI, content: Uint8Array, options: IFileWriteOptions): Promise<IFileWriteResult>;
}

export type WorkspaceConfigurationRequest =
	| { readonly operation: 'read'; readonly uri: string }
	| {
			readonly operation: 'write';
			readonly uri: string;
			readonly content: string;
			readonly options: IFileWriteOptions;
	  };

export function validateWorkspaceConfigurationRequest(value: unknown): WorkspaceConfigurationRequest {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new TypeError('Invalid workspace configuration request');
	const request = value as Record<string, unknown>;
	if (typeof request.uri !== 'string' || request.uri.length > 32768)
		throw new TypeError('Invalid workspace configuration URI');
	if (request.operation === 'read' && Object.keys(request).sort().join(',') === 'operation,uri')
		return request as WorkspaceConfigurationRequest;
	if (
		request.operation !== 'write' ||
		Object.keys(request).sort().join(',') !== 'content,operation,options,uri' ||
		typeof request.content !== 'string' ||
		request.content.length > 10 * 1024 * 1024 ||
		!request.options ||
		typeof request.options !== 'object' ||
		Array.isArray(request.options)
	)
		throw new TypeError('Invalid workspace configuration write');
	const options = request.options as Record<string, unknown>;
	if (
		Object.keys(options).some(key => !['create', 'overwrite', 'expectedRevision'].includes(key)) ||
		typeof options.create !== 'boolean' ||
		typeof options.overwrite !== 'boolean' ||
		(options.expectedRevision !== undefined && typeof options.expectedRevision !== 'string')
	)
		throw new TypeError('Invalid workspace configuration write options');
	return request as WorkspaceConfigurationRequest;
}
