import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { IObservable } from '../../../../base/common/observable.js';
import type { URI } from '../../../../base/common/uri.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { ArtifactResource, ArtifactRegistration, ArtifactSource } from '../../../../platform/artifactCatalog/common/artifactCatalog.js';

export type { ArtifactResource, ArtifactRegistration, ArtifactSource } from '../../../../platform/artifactCatalog/common/artifactCatalog.js';

/** Profile-wide artifact metadata; content and editor state remain with their owners. */
export interface IArtifactCatalogService {
	readonly onDidChange: Event<void>;
	readonly files: readonly ArtifactResource[];
	readonly loading: boolean;
	readonly error: string | undefined;
	refresh(): Promise<void>;
	/** The provider owns which authenticated account can see its imported files. */
	trackAccount(scope: IObservable<string | undefined>): IDisposable;
	/** Registers a resource already saved by its owner. */
	register(file: ArtifactRegistration): Promise<ArtifactResource>;
	isVisible(source: ArtifactSource): boolean;
	findBySource(source: ArtifactSource): ArtifactResource | undefined;
	hasResource(resource: URI): boolean;
}

export const IArtifactCatalogService = createServiceIdentifier<IArtifactCatalogService>('artifactCatalogService');
