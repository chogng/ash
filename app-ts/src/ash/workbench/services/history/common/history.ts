import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

/** Navigates through editor locations visited in the current Workbench. */
export interface IHistoryService {
	goBack(): Promise<void>;
	goForward(): Promise<void>;
}

export const IHistoryService = createServiceIdentifier<IHistoryService>('historyService');
