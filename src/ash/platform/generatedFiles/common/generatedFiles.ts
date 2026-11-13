import type { Event } from '../../../base/common/event.js';
import type { URI } from '../../../base/common/uri.js';

/** Coordinates identify the original output, independently of a renderer or connection. */
export interface GeneratedFileSource {
	readonly providerId: string;
	readonly accountId: string | null;
	readonly sessionId: string;
	readonly threadId: string;
	readonly itemId: string;
	readonly partId: string;
}

export interface GeneratedFileRegistration {
	readonly id: string;
	readonly resource: URI;
	readonly title: string;
	readonly contentType: string;
	readonly source: GeneratedFileSource;
}

/** A catalogue entry references a file, never a second editable document body. */
export interface GeneratedFile extends GeneratedFileRegistration {
	readonly createdAt: number;
}

/** Durable membership scoped to the UI host that can resolve the resource's provider. */
export interface IGeneratedFileCatalog {
	readonly onDidChange: Event<void>;
	list(clientId: string, accountIds: readonly string[]): Promise<readonly GeneratedFile[]>;
	register(clientId: string, file: GeneratedFileRegistration): Promise<GeneratedFile>;
}

export function generatedFileSourceKey(source: GeneratedFileSource): string {
	return JSON.stringify([source.providerId, source.accountId, source.sessionId, source.threadId, source.itemId, source.partId]);
}
