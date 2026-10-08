import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

export const SEARCH_VIEW_ID = "ash.searchView";
export const FOCUS_SEARCH_COMMAND_ID = "workbench.action.findInFiles";

export const enum SearchCommandIds {
	RemoveActionId = 'search.action.remove',
	CopyAllCommandId = 'search.action.copyAll',
	CopyMatchCommandId = 'search.action.copyMatch',
	CopyPathCommandId = 'search.action.copyPath',
	ExpandSearchResultsActionId = 'search.action.expandSearchResults',
	CancelSearchActionId = 'search.action.cancel',
	RefreshSearchResultsActionId = 'search.action.refreshSearchResults',
	ClearSearchResultsActionId = 'search.action.clearSearchResults',
}

export const SearchContext = {
	HasSearchResults: new RawContextKey<boolean>('hasSearchResult', false),
	ViewHasSomeCollapsibleKey: new RawContextKey<boolean>('viewHasSomeCollapsibleResult', false),
	ViewHasSearchPatternKey: new RawContextKey<boolean>('viewHasSearchPattern', false),
	ViewHasReplacePatternKey: new RawContextKey<boolean>('viewHasReplacePattern', false),
	ViewHasFilePatternKey: new RawContextKey<boolean>('viewHasFilePattern', false),
	SearchResultListFocusedKey: new RawContextKey<boolean>('searchResultListFocus', false),
	SearchViewFocusedKey: new RawContextKey<boolean>('searchViewletFocus', false),
	FileMatchOrMatchFocusKey: new RawContextKey<boolean>('fileMatchOrMatchFocus', false),
	FileMatchOrFolderMatchWithResourceFocusKey: new RawContextKey<boolean>('fileMatchOrFolderMatchWithResourceFocus', false),
};
