import { combinedDisposable } from '../../../base/common/lifecycle.js';
import type { Event } from '../../../base/common/event.js';
import { URI } from '../../../base/common/uri.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import type { GeneratedFileDto } from '../../../../../.build/protocol/typescript/index.js';
import type { GeneratedFile, GeneratedFileRegistration, IGeneratedFileCatalog } from '../common/generatedFiles.js';

/** Only the adapter consumes transport DTOs; consumers receive resource-based domain contracts. */
export class AppServerGeneratedFileCatalog implements IGeneratedFileCatalog {
	readonly onDidChange: Event<void>;

	constructor(private readonly connection: AppServerProtocolClient) {
		this.onDidChange = listener => combinedDisposable(
			connection.onNotification(event => { if (event.method === 'generatedFile/changed') listener(); }),
			connection.onStateChange(state => { if (state === 'ready') listener(); }),
		);
	}

	async list(clientId: string, accountIds: readonly string[]): Promise<readonly GeneratedFile[]> {
		const result = await appServerRequest(this.connection, 'generatedFile/list', { clientId, accountIds: [...accountIds] });
		return result.files.map(fromDto);
	}

	async register(clientId: string, file: GeneratedFileRegistration): Promise<GeneratedFile> {
		const result = await appServerRequest(this.connection, 'generatedFile/register', {
			clientId, file: { ...file, resource: file.resource.toString() },
		});
		return fromDto(result.file);
	}
}

function fromDto(file: GeneratedFileDto): GeneratedFile {
	return { ...file, resource: URI.parse(file.resource), source: { ...file.source } };
}
