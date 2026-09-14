import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../app-server/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import type { IInstructionApi } from '../common/instructionApi.js';

export function createDisconnectedInstructionApi(unavailable: UnavailableOperation): IInstructionApi {
	return { list: () => unavailable('instructions.list') };
}

export function createAppServerInstructionApi(connection: AppServerProtocolClient): IInstructionApi {
	return {
		list: async sessionId => {
			const catalog = await appServerRequest(connection, 'instructions/list', sessionId ? { sessionId } : {});
			return {
				instructions: catalog.instructions.map(entry => ({
					reference: {
						source: { ...entry.reference.source },
						relativePath: entry.reference.relativePath,
						digest: entry.reference.digest,
					},
					name: entry.name,
					loadPolicy: entry.loadPolicy,
					path: entry.path,
				})),
				diagnostics: catalog.diagnostics.map(diagnostic => ({
					source: { ...diagnostic.source },
					relativePath: diagnostic.relativePath ?? undefined,
					code: diagnostic.code,
					message: diagnostic.message,
				})),
			};
		},
	};
}
