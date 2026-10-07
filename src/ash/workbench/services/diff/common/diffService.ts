import { type IDisposable } from '../../../../base/common/lifecycle.js';
import { type IDocumentDiffProvider } from '../../../../editor/common/diff/documentDiffProvider.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

/** Workbench-owned factory for editor diff computations. */
export interface IDiffService {
	createComputationService(): IDocumentDiffProvider & IDisposable;
}

export const IDiffService = createServiceIdentifier<IDiffService>('diffService');
