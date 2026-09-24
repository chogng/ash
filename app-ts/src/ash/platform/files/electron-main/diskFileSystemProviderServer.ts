import { URI } from '../../../base/common/uri.js';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';
import { LOCAL_FILE_SYSTEM_CHANNEL_NAME } from '../common/diskFileSystemProviderClient.js';
import { FileNotFoundError, FileRevisionConflictError, type IFileService } from '../common/files.js';

/** Exposes only the file operations supported by a host-granted provider. */
export function diskFileSystemProviderRoutes(provider: IFileService, userDataHome: URI): readonly IpcRoute<unknown, unknown>[] {
	return [
		{ channel: `${LOCAL_FILE_SYSTEM_CHANNEL_NAME}:userDataHome`, validate: value => { if (value !== undefined) throw new Error('No arguments expected'); return value; }, invoke: () => userDataHome.toString() },
		{ channel: LOCAL_FILE_SYSTEM_CHANNEL_NAME, validate: validateRequest, invoke: async value => {
			const request = validateRequest(value);
			const resource = URI.parse(request.resource as string);
			try {
				let result: unknown;
				switch (request.operation) {
					case 'stat': result = { ...await provider.stat(resource), resource: resource.toString() }; break;
					case 'readDirectory': result = (await provider.readDirectory(resource)).map(entry => ({ ...entry, resource: entry.resource.toString() })); break;
					case 'readFile': result = { ...await provider.readFile(resource), resource: resource.toString() }; break;
					case 'readFileBytes': result = { ...await provider.readFileBytes(resource), resource: resource.toString() }; break;
					case 'writeFile': {
						const written = await provider.writeFile({ resource, content: request.content as string, ...(request.expectedRevision === undefined ? {} : { expectedRevision: request.expectedRevision as string }) });
						result = { ...written, stat: { ...written.stat, resource: resource.toString() } };
						break;
					}
					case 'createFile': result = { ...await provider.createFile(resource, request.existing as 'error' | 'overwrite' | 'ignore'), resource: resource.toString() }; break;
					case 'rename': result = await provider.rename(resource, URI.parse(request.target as string), request.existing as 'error' | 'overwrite' | 'ignore'); break;
					case 'delete': result = await provider.delete(resource, request.missing as 'error' | 'ignore', request.mode as 'fileOrEmptyDirectory' | 'recursive'); break;
				}
				return { ok: true, value: result };
			} catch (error) {
				return { ok: false, code: error instanceof FileNotFoundError ? 'notFound' : error instanceof FileRevisionConflictError ? 'conflict' : 'failed', message: error instanceof Error ? error.message : String(error) };
			}
		} },
	];
}

function validateRequest(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid file request');
	const request = value as Record<string, unknown>;
	const operations = ['stat', 'readDirectory', 'readFile', 'readFileBytes', 'writeFile', 'createFile', 'rename', 'delete'];
	if (!operations.includes(request.operation as string) || typeof request.resource !== 'string' || request.resource.length > 8192) throw new Error('Invalid file operation or resource');
	if (request.operation === 'writeFile' && (typeof request.content !== 'string' || request.content.length > 16_777_216 || (request.expectedRevision !== undefined && typeof request.expectedRevision !== 'string'))) throw new Error('Invalid file write');
	if ((request.operation === 'createFile' || request.operation === 'rename') && !['error', 'overwrite', 'ignore'].includes(request.existing as string)) throw new Error('Invalid existing target behavior');
	if (request.operation === 'rename' && typeof request.target !== 'string') throw new Error('Invalid target resource');
	if (request.operation === 'delete' && (!['error', 'ignore'].includes(request.missing as string) || !['fileOrEmptyDirectory', 'recursive'].includes(request.mode as string))) throw new Error('Invalid file delete');
	return request;
}
