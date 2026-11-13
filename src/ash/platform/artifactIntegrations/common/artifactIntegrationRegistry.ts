import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { observableValue, type IObservable } from '../../../base/common/observable.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { IArtifactIntegration } from './artifactIntegration.js';

export const IArtifactIntegrationRegistry = createServiceIdentifier<IArtifactIntegrationRegistry>('artifactIntegrationRegistry');

export interface IArtifactIntegrationRegistry {
	readonly integrations: IObservable<readonly IRegisteredArtifactIntegration[]>;
	register(integration: IArtifactIntegration, runtimeId: string): IDisposable;
}

export interface IRegisteredArtifactIntegration {
	readonly integration: IArtifactIntegration;
	readonly runtimeId: string;
}

export class ArtifactIntegrationRegistry extends Disposable implements IArtifactIntegrationRegistry {
	private readonly registrations = observableValue<readonly IRegisteredArtifactIntegration[]>(this, []);
	readonly integrations = this.registrations;

	register(integration: IArtifactIntegration, runtimeId: string): IDisposable {
		this.assertNotDisposed();
		const current = this.registrations.get();
		if (!integration.id.trim() || !runtimeId.trim() || current.some(candidate => candidate.integration.id === integration.id && candidate.runtimeId === runtimeId)) {
			throw new Error(`Invalid or duplicate artifact integration: ${integration.id}`);
		}
		const registration = { integration, runtimeId };
		this.registrations.set([...current, registration]);
		return toDisposable(() => {
			if (this.isDisposed) return;
			this.registrations.set(this.registrations.get().filter(candidate => candidate !== registration));
		});
	}

	protected override disposeCore(): void {
		this.registrations.set([]);
		super.disposeCore();
	}
}
