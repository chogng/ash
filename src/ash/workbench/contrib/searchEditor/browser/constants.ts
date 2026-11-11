import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import type { IResourceEditorInput } from '../../../common/editor.js';

export const SearchEditorID = 'workbench.editor.searchEditor';
export const OpenNewEditorCommandId = 'search.action.openNewEditor';
export const InSearchEditor = new RawContextKey<boolean>('inSearchEditor', false);

export function isSearchEditorInput(input: IResourceEditorInput): boolean {
	return input.editorId === SearchEditorID || input.resource.path.endsWith('.code-search');
}
