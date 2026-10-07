import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

export const SearchEditorID = 'workbench.editor.searchEditor';
export const OpenNewEditorCommandId = 'search.action.openNewEditor';
export const InSearchEditor = new RawContextKey<boolean>('inSearchEditor', false);
