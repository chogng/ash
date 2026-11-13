import { toDisposable } from '../../../base/common/lifecycle.js';
import { Event } from '../../../base/common/event.js';
import type { IGeneratedFilesService } from '../../services/generatedFiles/common/generatedFilesService.js';

/** Explicit fixture for compositions that do not publish generated documents. */
export function createTestGeneratedFilesService(): IGeneratedFilesService {
	return {
		onDidChange: Event.None,
		files: [], loading: false, error: undefined,
		refresh: async () => { },
		trackAccount: () => toDisposable(() => { }),
		isProfileGeneratedPath: () => false,
		publishMarkdown: async () => { throw new Error('Unexpected generated file publication'); },
		findBySource: () => undefined,
		isGeneratedResource: () => false,
	};
}
