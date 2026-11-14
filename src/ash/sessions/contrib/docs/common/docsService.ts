import type { Event } from '../../../../base/common/event.js';
import type { URI } from '../../../../base/common/uri.js';
import type { ArtifactResource, ArtifactSource } from '../../../../platform/artifactCatalog/common/artifactCatalog.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

/** Docs creation and import recovery, independent of catalog membership and editor state. */
export interface IDocsService {
	readonly onDidChange: Event<void>;
	readonly error: string | undefined;
	importMarkdown(source: ArtifactSource, markdown: string, title?: string): Promise<ArtifactResource>;
	recoverImports(): Promise<void>;
	isProfileDocumentPath(resource: URI): boolean;
}

export const IDocsService = createServiceIdentifier<IDocsService>('docsService');
