import { throwIfCancelled } from '../../../base/common/cancellation.js';
import { Event } from '../../../base/common/event.js';
import { CancellationError } from '../../../base/common/errors.js';
import { AppServerRemoteError } from '../../agentHost/common/appServerError.js';
import { APP_SERVER_METHODS } from '../../../../../.build/protocol/typescript/index.js';
import type { AppServerProtocolClient } from "../../agentHost/browser/appServerProtocolClient.js";
import { appServerRequest, voidResult } from "../../agentHost/browser/appServerRequest.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { IFileApi } from "../common/fileApi.js";

export function createDisconnectedFileApi(unavailable: UnavailableOperation): IFileApi {
	return {
		connectionGeneration: 0,
		onDidChangeConnection: Event.None,
		readPathCaseSensitivity: () => unavailable('fs.readPathCaseSensitivity'),
		writeFileElevated: () => unavailable("fs.writeFileElevated"),
		getMetadata: () => unavailable("fs.getMetadata"),
		readDirectory: () => unavailable("fs.readDirectory"),
		readFile: () => unavailable("fs.readFile"),
		readBinaryFile: () => unavailable("fs.readBinaryFile"),
		writeFile: () => unavailable("fs.writeFile"),
		writeBinaryFile: () => unavailable("fs.writeBinaryFile"),
		createFile: () => unavailable("fs.createFile"),
		createDirectory: () => unavailable("fs.createDirectory"),
		copy: () => unavailable("fs.copy"),
		pasteSystemFiles: async () => false,
		rename: () => unavailable("fs.rename"),
		delete: () => unavailable("fs.delete"),
	};
}

export function createAppServerFileApi(connection: AppServerProtocolClient): IFileApi {
	return {
		get connectionGeneration() { return connection.generation; },
		onDidChangeConnection: listener => connection.onStateChange(() => listener()),
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
		getMetadata: (params) => appServerRequest(connection, "fs/getMetadata", params),
		readDirectory: (params) => appServerRequest(connection, "fs/readDirectory", params),
		readFile: (params) => appServerRequest(connection, "fs/readFile", params),
		readBinaryFile: (params) => appServerRequest(connection, "fs/readBinaryFile", params),
		writeFile: (params) => appServerRequest(connection, "fs/writeFile", params),
		writeBinaryFile: (params) => appServerRequest(connection, "fs/writeBinaryFile", params),
		createFile: (params) => appServerRequest(connection, "fs/createFile", params),
		createDirectory: (params) => appServerRequest(connection, "fs/createDirectory", params),
		copy: (params) => voidResult(appServerRequest(connection, "fs/copy", params)),
		pasteSystemFiles: (params) => appServerRequest(connection, "fs/pasteSystemFiles", params),
		rename: (params) => voidResult(appServerRequest(connection, "fs/rename", params)),
		delete: (params) => voidResult(appServerRequest(connection, "fs/delete", params)),
	};
}
