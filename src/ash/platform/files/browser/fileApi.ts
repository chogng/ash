import { URI } from '../../../base/common/uri.js';
import { raceCancellationError } from '../../../base/common/async.js';
import { throwIfCancelled, type CancellationToken } from '../../../base/common/cancellation.js';
import { encodeBase64, VSBuffer } from '../../../base/common/buffer.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { Event } from '../../../base/common/event.js';
import { CancellationError } from '../../../base/common/errors.js';
import { localize } from '../../../nls.js';
import { AppServerRemoteError } from '../../agentHost/common/appServerError.js';
import { APP_SERVER_METHODS } from '../../../../../.build/protocol/typescript/index.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest, voidResult } from '../../agentHost/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../agentHost/browser/disconnectedAppServer.js';
import type { FileInvalidation, IFileApi } from '../common/fileApi.js';
import { ASH_REMOTE_SCHEME, getRemoteWorkspacePath, withRemoteWorkspacePath } from '../../remote/common/remote.js';

const fileImportChunkBytes = 192 * 1024;

export function createDisconnectedFileApi(unavailable: UnavailableOperation): IFileApi {
	return {
		connectionGeneration: 0,
		resolvePath: () => unavailable('fs.resolvePath'),
		onDidChangeConnection: Event.None,
		onDidChangeFiles: Event.None,
		readPathCaseSensitivity: () => unavailable('fs.readPathCaseSensitivity'),
		writeFileElevated: () => unavailable('fs.writeFileElevated'),
		getMetadata: () => unavailable('fs.getMetadata'),
		readDirectory: () => unavailable('fs.readDirectory'),
		readFile: () => unavailable('fs.readFile'),
		readBinaryFile: () => unavailable('fs.readBinaryFile'),
		writeFile: () => unavailable('fs.writeFile'),
		writeBinaryFile: () => unavailable('fs.writeBinaryFile'),
		createFile: () => unavailable('fs.createFile'),
		createDirectory: () => unavailable('fs.createDirectory'),
		copy: () => unavailable('fs.copy'),
		pasteSystemFiles: async () => false,
		rename: () => unavailable('fs.rename'),
		delete: () => unavailable('fs.delete'),
		deleteFileIfUnchanged: () => unavailable('fs.deleteFileIfUnchanged'),
	};
}

export function createAppServerFileApi(connection: AppServerProtocolClient): IFileApi {
	return {
		async resolvePath(resource) {
			const remote = resource.scheme === ASH_REMOTE_SCHEME;
			const canonicalResource = resource.with({ query: null, fragment: null });
			// Remote URI spelling belongs to the target OS, including Windows drive and UNC roots.
			const path = remote ? getRemoteWorkspacePath(canonicalResource) : resource.scheme === 'file' ? resource.fsPath : resource.path;
			const result = await appServerRequest(connection, 'fs/resolvePath', { path });
			return {
				uri: remote ? withRemoteWorkspacePath(canonicalResource, result.root) : canonicalResource.with({ path: URI.file(result.root).path }),
				...(result.exactFile && { exactFile: resource.with({ query: null, fragment: null }) }),
				target: result.target.type === 'environment' ? result.target : { type: 'session', ...result.target.sessionDirectory },
			};
		},
		get connectionGeneration() { return connection.generation; },
		onDidChangeConnection: listener => connection.onStateChange(() => listener()),
		onDidChangeFiles: Event.any<FileInvalidation>((listener, thisArgs) => connection.onNotification(notification => {
			if (notification.method === 'fs/changed') listener.call(thisArgs, notification.params);
		}), (listener, thisArgs) => connection.onStateChange(state => {
			// A replacement backend cannot replay changes missed while its connection was down.
			if (state === 'ready') listener.call(thisArgs, { type: 'rescanRequired' });
		})),
		readPathCaseSensitivity: params => appServerRequest(connection, 'fs/readPathCaseSensitivity', params),
		writeFileElevated: async (params, signal) => {
			if (signal) { throwIfCancelled(signal, 'Elevated file save was cancelled'); }
			const result = connection.request(APP_SERVER_METHODS['fs/writeFileElevated'], params, { timeoutMs: 240_000 });
			let cancellation: Promise<unknown> | undefined;
			const cancel = (): void => {
				cancellation ??= appServerRequest(connection, 'fs/writeFileElevated/cancel', { operationId: params.operationId, ...(params.dirId === undefined ? {} : { dirId: params.dirId }), ...(params.sessionDirectory === undefined ? {} : { sessionDirectory: params.sessionDirectory }) });
				void cancellation.catch(() => undefined);
			};
			signal?.addEventListener('abort', cancel, { once: true });
			if (signal?.aborted) { cancel(); }
			try {
				return await result;
			} catch (error) {
				if (error instanceof AppServerRemoteError && error.errorName === 'RequestCancelled') { throw new CancellationError(); }
				throw error;
			} finally {
				signal?.removeEventListener('abort', cancel);
				// Keep the write response registered through cancellation so a published save retains its revision.
				await cancellation?.catch(() => undefined);
			}
		},
		getMetadata: (params) => appServerRequest(connection, 'fs/getMetadata', params),
		readDirectory: (params) => appServerRequest(connection, 'fs/readDirectory', params),
		readFile: ({ candidateGuessEncodings, ...params }) => appServerRequest(connection, 'fs/readFile', {
			...params,
			...(candidateGuessEncodings === undefined ? {} : { candidateGuessEncodings: [...candidateGuessEncodings] }),
		}),
		readBinaryFile: ({ transfer, ...params }, token) => transfer && connection.capabilities?.contracts.fileImport?.version === 1
			? readTransferSnapshot(connection, params, token)
			: appServerRequest(connection, 'fs/readBinaryFile', params),
		writeFile: (params) => appServerRequest(connection, 'fs/writeFile', params),
		writeBinaryFile: (params) => appServerRequest(connection, 'fs/writeBinaryFile', params),
		get importFile() {
			return connection.capabilities?.contracts.fileImport?.version === 1
				? (...params: Parameters<NonNullable<IFileApi['importFile']>>) => importFile(connection, ...params)
				: undefined;
		},
		createFile: (params) => appServerRequest(connection, 'fs/createFile', params),
		createDirectory: (params) => appServerRequest(connection, 'fs/createDirectory', params),
		copy: (params) => voidResult(appServerRequest(connection, 'fs/copy', params)),
		pasteSystemFiles: (params) => appServerRequest(connection, 'fs/pasteSystemFiles', params),
		rename: (params) => voidResult(appServerRequest(connection, 'fs/rename', params)),
		delete: (params) => voidResult(appServerRequest(connection, 'fs/delete', params)),
		deleteFileIfUnchanged: async params => {
			const result = await appServerRequest(connection, 'fs/deleteFileIfUnchanged', params);
			if (result.kind === 'recoveryRequired') {
				throw new Error(localize('files.deleteRecoveryRequired', 'The file was kept for recovery at {0}.', result.path));
			}
		},
	};
}

async function readTransferSnapshot(connection: AppServerProtocolClient, params: Parameters<IFileApi['readBinaryFile']>[0], token?: CancellationToken) {
	if (token) throwIfCancelled(token);
	const operationId = generateUuid();
	const generation = connection.generation;
	const { dirId, sessionDirectory } = params;
	const pending = connection.request(APP_SERVER_METHODS['fs/readBinaryFile'], { ...params, transfer: true, operationId }, { timeoutMs: 240_000 });
	using cancelled = token?.onCancellationRequested(() => {
		if (connection.state === 'ready' && generation === connection.generation) {
			void appServerRequest(connection, 'fs/readBinaryFile/cancel', { operationId, dirId, sessionDirectory }).catch(() => undefined);
		}
	});
	try {
		// A successful allocation still needs its owner to release the resource.
		return await pending;
	} catch (error) {
		if (error instanceof AppServerRemoteError && error.errorName === 'RequestCancelled') throw new CancellationError();
		throw error;
	}
}

async function importFile(connection: AppServerProtocolClient, target: Parameters<NonNullable<IFileApi['importFile']>>[0], contents: AsyncIterable<Uint8Array>, sizeBytes: number, token: CancellationToken) {
	const generation = connection.generation;
	const { path, ...scope } = target;
	const upload = { ...scope, uploadId: generateUuid() };
	const check = (): void => {
		throwIfCancelled(token);
		if (connection.state !== 'ready' || connection.generation !== generation) throw new CancellationError();
	};
	let cancellation: Promise<unknown> | undefined;
	const cancel = (): Promise<unknown> | undefined => {
		if (connection.state === 'ready' && generation === connection.generation) {
			cancellation ??= appServerRequest(connection, 'fs/upload/cancel', upload).catch(() => undefined);
		}
		return cancellation;
	};
	check();
	let published = false;
	try {
		await appServerRequest(connection, 'fs/upload/start', { ...upload, path, sizeBytes });
		check();
		using stop = token.onCancellationRequested(() => { void cancel(); });
		let offset = 0;
		for await (const chunk of contents) {
			for (let start = 0; start < chunk.byteLength; start += fileImportChunkBytes) {
				check();
				const bytes = chunk.subarray(start, start + fileImportChunkBytes);
				await raceCancellationError(appServerRequest(connection, 'fs/upload/write', { ...upload, offset, dataBase64: encodeBase64(VSBuffer.wrap(Uint8Array.from(bytes))) }), token);
				offset += bytes.byteLength;
			}
		}
		check();
		const result = await connection.request(APP_SERVER_METHODS['fs/upload/finish'], upload, { timeoutMs: 240_000 });
		published = true;
		return result;
	} catch (error) {
		if (token.isCancellationRequested || error instanceof AppServerRemoteError && error.errorName === 'RequestCancelled') throw new CancellationError();
		throw error;
	} finally {
		if (!published) await cancel();
	}
}
