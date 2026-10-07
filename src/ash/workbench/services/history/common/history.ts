import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

export const enum GoFilter {
	NONE,
	EDITS,
	NAVIGATION,
}

/** Navigates through editors and locations visited in the current Workbench. */
export interface IHistoryService {
	goBack(filter?: GoFilter): Promise<void>;
	goForward(filter?: GoFilter): Promise<void>;
}

export const IHistoryService = createServiceIdentifier<IHistoryService>('historyService');
