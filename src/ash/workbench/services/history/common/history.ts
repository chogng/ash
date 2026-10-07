import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IResourceEditorInput } from '../../../common/editor.js';

export const enum GoFilter {
	NONE,
	EDITS,
	NAVIGATION,
}

/** Navigates through editors and locations visited in the current Workbench. */
export interface IHistoryService {
	getHistory(): readonly IResourceEditorInput[];
	goBack(filter?: GoFilter): Promise<void>;
	goForward(filter?: GoFilter): Promise<void>;
	/** Reopens the most recently closed available editor as a pinned tab. */
	reopenLastClosedEditor(): Promise<void>;
}

export const IHistoryService = createServiceIdentifier<IHistoryService>('historyService');
