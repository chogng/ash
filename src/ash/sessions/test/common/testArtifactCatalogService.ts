import { toDisposable } from '../../../base/common/lifecycle.js';
import { Event } from '../../../base/common/event.js';
import type { IArtifactCatalogService } from '../../services/artifactCatalog/common/artifactCatalogService.js';
import type { IDocsService } from '../../contrib/docs/common/docsService.js';

/** Explicit fixtures for compositions without retained resources or document imports. */
export function createTestArtifactCatalogService(): IArtifactCatalogService {
	return {
		refresh: async () => { }, trackAccount: () => toDisposable(() => { }),
		onDidChange: Event.None, files: [], loading: false, error: undefined,
		register: async () => { throw new Error('Unexpected artifact registration'); },
		isVisible: source => source.accountId === null,
		findBySource: () => undefined, hasResource: () => false,
	};
}

export function createTestDocsService(): IDocsService {
	return {
		onDidChange: Event.None, error: undefined,
		recoverImports: async () => { }, isProfileDocumentPath: () => false,
		importMarkdown: async () => { throw new Error('Unexpected document import'); },
	};
}
