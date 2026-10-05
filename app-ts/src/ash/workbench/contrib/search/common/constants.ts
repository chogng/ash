import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

export const SearchContext = {
	SearchViewFocusedKey: new RawContextKey<boolean>('searchViewletFocus', false),
};
