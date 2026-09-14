import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../app-server/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import type { IInstructionImportApi, InstructionImportScope } from '../common/instructionImportApi.js';

function wireScope(scope: InstructionImportScope): { readonly type: 'user' | 'workspace' } {
	return { type: scope.type };
}

export function createDisconnectedInstructionImportApi(unavailable: UnavailableOperation): IInstructionImportApi {
	return {
		preview: () => unavailable('instructions.import.preview'),
		apply: () => unavailable('instructions.import.apply'),
	};
}

export function createAppServerInstructionImportApi(connection: AppServerProtocolClient): IInstructionImportApi {
	return {
		preview: async scope => {
			const preview = await appServerRequest(connection, 'instructions/import/preview', { scope: wireScope(scope) });
			return {
				source: preview.source ? { ...preview.source } : undefined,
				target: preview.target,
				targetConflict: preview.targetConflict,
				diagnostics: preview.diagnostics.map(diagnostic => ({ ...diagnostic })),
			};
		},
		apply: async (scope, source, expectedTarget) => {
			const result = await appServerRequest(connection, 'instructions/import/apply', {
				scope: wireScope(scope),
				relativePath: source.relativePath,
				expectedSha256: source.sha256,
				expectedTarget,
			});
			return { ...result };
		},
	};
}
