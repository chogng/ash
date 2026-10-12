import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IEnvironmentVariableCollection, IMergedEnvironmentVariableCollection } from '../../../../platform/terminal/common/environmentVariable.js';
import type { ITerminalStatus } from '../../../services/terminal/common/terminal.js';

export interface IEnvironmentVariableInfo {
	readonly requiresAction: boolean;
	getStatus(): ITerminalStatus | undefined;
}

export interface IEnvironmentVariableCollectionWithPersistence extends IEnvironmentVariableCollection {
	readonly persistent: boolean;
}

export interface IEnvironmentVariableService {
	readonly collections: ReadonlyMap<string, IEnvironmentVariableCollectionWithPersistence>;
	readonly mergedCollection: IMergedEnvironmentVariableCollection;
	readonly onDidChangeCollections: Event<IMergedEnvironmentVariableCollection>;
	set(extensionIdentifier: string, collection: IEnvironmentVariableCollectionWithPersistence): void;
	delete(extensionIdentifier: string): void;
	/** Refreshes admitted extension snapshots at the launch boundary, under their original lifetime. */
	registerCollectionProvider(extensionIdentifier: string, read: () => Promise<IEnvironmentVariableCollectionWithPersistence>): IDisposable;
	refreshCollections(): Promise<void>;
}

export const IEnvironmentVariableService = createServiceIdentifier<IEnvironmentVariableService>('environmentVariableService');
