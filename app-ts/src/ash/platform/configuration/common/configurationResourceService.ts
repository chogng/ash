import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

/** Exact editable projection of the current profile's explicitly configured values. */
export interface IConfigurationResourceSnapshot {
	readonly source: string;
	readonly revision: number;
}

/** Replaces the current profile configuration only when its observed revision is still current. */
export interface IConfigurationResourceService {
	readonly onDidChangeResource: Event<IConfigurationResourceSnapshot>;

	read(): Promise<IConfigurationResourceSnapshot>;
	write(source: string, expectedRevision: number): Promise<IConfigurationResourceSnapshot>;
}

export class ConfigurationResourceRevisionConflictError extends Error {
	constructor(readonly expectedRevision: number, readonly actualRevision: number | undefined) {
		super(actualRevision === undefined
			? `Configuration changed after revision ${expectedRevision}`
			: `Configuration revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
		this.name = 'ConfigurationResourceRevisionConflictError';
	}
}

export const IConfigurationResourceService = createServiceIdentifier<IConfigurationResourceService>('configurationResourceService');
