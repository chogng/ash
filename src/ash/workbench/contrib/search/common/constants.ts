import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

export const SEARCH_VIEW_ID = "ash.searchView";
export const FOCUS_SEARCH_COMMAND_ID = "workbench.action.findInFiles";

export const enum SearchCommandIds {
	RemoveActionId = 'search.action.remove',
	CopyAllCommandId = 'search.action.copyAll',
	CopyMatchCommandId = 'search.action.copyMatch',
	CopyPathCommandId = 'search.action.copyPath',
}

export const SearchContext = {
	SearchViewFocusedKey: new RawContextKey<boolean>('searchViewletFocus', false),
	FileMatchOrMatchFocusKey: new RawContextKey<boolean>('fileMatchOrMatchFocus', false),
	FileMatchOrFolderMatchWithResourceFocusKey: new RawContextKey<boolean>('fileMatchOrFolderMatchWithResourceFocus', false),
};
