import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import type { IInstructionService } from '../common/instructionService.js';

export function createAppServerInstructionService(connection: AppServerProtocolClient): IInstructionService {
	return {
		isAvailable: true,
		list: async sessionId => (await appServerRequest(connection, 'instructions/list', sessionId ? { sessionId } : {})).instructions.map(instruction => ({
			path: instruction.path,
			name: instruction.name,
			description: instruction.description ?? undefined,
			scope: instruction.scope,
		})),
	};
}

export function createDisconnectedInstructionService(unavailable: UnavailableOperation): IInstructionService {
	return { isAvailable: false, list: () => unavailable('instructions/list') };
}
