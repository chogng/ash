import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IContentSearchQuery } from '../../../../platform/search/common/search.js';
import type { IBulkEditResult } from '../../../../editor/browser/services/bulkEditService.js';
import type { SearchMatch } from './searchTreeModel/searchResult.js';

export type SearchReplaceResult = IBulkEditResult & { readonly saveErrors: readonly string[]; };

export interface IReplaceService {
	replace(matches: readonly SearchMatch[], query: IContentSearchQuery, replacement: string, options: { readonly preview: boolean; readonly preserveCase: boolean; readonly signal: AbortSignal; }): Promise<SearchReplaceResult>;
}

export const IReplaceService = createServiceIdentifier<IReplaceService>('replaceService');
