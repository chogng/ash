import { combinedDisposable } from '../../../base/common/lifecycle.js';
import type { Event } from '../../../base/common/event.js';
import { URI } from '../../../base/common/uri.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import type { ArtifactResourceDto } from '../../../../../.build/protocol/typescript/index.js';
import type { ArtifactResource, ArtifactRegistration, IArtifactCatalog } from '../common/artifactCatalog.js';

/** Only the adapter consumes transport DTOs; consumers receive resource-based domain contracts. */
export class AppServerArtifactCatalog implements IArtifactCatalog {
	readonly onDidChange: Event<void>;

	constructor(private readonly connection: AppServerProtocolClient) {
		this.onDidChange = listener => combinedDisposable(
			connection.onNotification(event => { if (event.method === 'artifactCatalog/changed') listener(); }),
			connection.onStateChange(state => { if (state === 'ready') listener(); }),
		);
	}

	async list(clientId: string, accountIds: readonly string[]): Promise<readonly ArtifactResource[]> {
		const result = await appServerRequest(this.connection, 'artifactCatalog/list', { clientId, accountIds: [...accountIds] });
		return result.files.map(fromDto);
	}

	async register(clientId: string, file: ArtifactRegistration): Promise<ArtifactResource> {
		const result = await appServerRequest(this.connection, 'artifactCatalog/register', {
			clientId, file: { ...file, resource: file.resource.toString() },
		});
		return fromDto(result.file);
	}
}

function fromDto(file: ArtifactResourceDto): ArtifactResource {
	return { ...file, resource: URI.parse(file.resource), source: { ...file.source } };
}
