import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import { ArtifactExecutionService } from './artifactExecutionService.js';
import { artifactBindingId, type ArtifactAction, type ArtifactRecord, type IArtifactIntegrationBinding } from './artifactIntegration.js';
import { IArtifactIntegrationRegistry } from './artifactIntegrationRegistry.js';

export const IArtifactIntegrationService = createServiceIdentifier<IArtifactIntegrationService>('artifactIntegrationService');

export interface IArtifactIntegrationService {
	invoke(
		authority: string,
		runtimeId: string,
		session: string,
		artifact: ArtifactRecord,
		select: (binding: IArtifactIntegrationBinding, token: CancellationToken) => Promise<ArtifactAction | undefined>,
		token: CancellationToken,
	): Promise<void>;
}

/** Resolves a recorded artifact to a registered provider for one explicit invocation. */
export class ArtifactIntegrationService extends Disposable implements IArtifactIntegrationService {
	private readonly execution = this._register(new ArtifactExecutionService());

	constructor(@IArtifactIntegrationRegistry private readonly registry: IArtifactIntegrationRegistry) {
		super();
	}

	async invoke(
		authority: string,
		runtimeId: string,
		session: string,
		artifact: ArtifactRecord,
		select: (binding: IArtifactIntegrationBinding, token: CancellationToken) => Promise<ArtifactAction | undefined>,
		token: CancellationToken,
	): Promise<void> {
		if (token.isCancellationRequested || this.isDisposed) throw new CancellationError();
		const resource = URI.parse(artifact.resource, true);
		const registration = this.registry.integrations.get().find(candidate => candidate.runtimeId === runtimeId && candidate.integration.match(resource, token, artifact));
		if (!registration) throw new CancellationError();
		const { integration } = registration;
		const id = artifactBindingId(authority, session, artifact.id, integration.id);
		using source = new CancellationTokenSource(token);
		using subscription = this.registry.integrations.onDidChange(integrations => {
			if (!integrations.includes(registration)) source.cancel();
		});
		await this.execution.invoke(id, token => integration.createBinding(session, artifact, id, token), select, source.token);
	}
}
