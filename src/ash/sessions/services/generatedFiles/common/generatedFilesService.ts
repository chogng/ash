import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { IObservable } from '../../../../base/common/observable.js';
import type { URI } from '../../../../base/common/uri.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { GeneratedFile, GeneratedFileSource } from '../../../../platform/generatedFiles/common/generatedFiles.js';
import type { ISessionArtifact } from '../../sessions/common/session.js';

export type { GeneratedFile, GeneratedFileSource } from '../../../../platform/generatedFiles/common/generatedFiles.js';

/** Publishes durable resources; file models and working copies remain with their editors. */
export interface IGeneratedFilesService {
	readonly onDidChange: Event<void>;
	readonly files: readonly GeneratedFile[];
	readonly loading: boolean;
	readonly error: string | undefined;
	refresh(): Promise<void>;
	/** The provider owns which authenticated account can see its imported files. */
	trackAccount(scope: IObservable<string | undefined>): IDisposable;
	/** A stable source is imported once. Replaying Chat never overwrites the user's file. */
	publishMarkdown(source: GeneratedFileSource, markdown: string, title?: string): Promise<GeneratedFile>;
	findBySource(source: GeneratedFileSource): GeneratedFile | undefined;
	isGeneratedResource(resource: URI): boolean;
	isProfileGeneratedPath(resource: URI): boolean;
}

export const IGeneratedFilesService = createServiceIdentifier<IGeneratedFilesService>('generatedFilesService');

/** Projects the current chat's artifacts from the same catalogue used by the Artifacts home. */
export function getGeneratedFileSessionArtifacts(files: readonly GeneratedFile[], chat: Omit<GeneratedFileSource, 'itemId' | 'partId'>): readonly ISessionArtifact[] {
	return files.filter(({ source }) => source.providerId === chat.providerId && source.accountId === chat.accountId
		&& source.sessionId === chat.sessionId && source.threadId === chat.threadId)
		.map(file => ({ id: file.id, kind: 'file', label: file.title, uri: file.resource }));
}
