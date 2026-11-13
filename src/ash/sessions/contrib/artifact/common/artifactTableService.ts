import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IObservable } from '../../../../base/common/observable.js';
import type { ArtifactTableModel } from './artifactTableModel.js';

export const IArtifactTableService = createServiceIdentifier<IArtifactTableService>('artifactTableService');

export interface IArtifactTableService {
	readonly drafts: IObservable<ReadonlyMap<string, ArtifactTableModel>>;
	readonly isRestoring: IObservable<boolean>;
	readonly ready: Promise<void>;
	resource(draft: ArtifactTableModel): URI;
	rename(draft: ArtifactTableModel, title: string): Promise<void>;
	delete(draft: ArtifactTableModel): Promise<void>;
}
