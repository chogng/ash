import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { StorageScope, StorageTarget, type IStorageService } from '../../../../platform/storage/common/storage.js';

export const TOGGLE_MULTI_DIFF_EDITOR_FILE_LIST_COMMAND_ID = 'multiDiffEditor.toggleFileList';
export const MultiDiffEditorFileListAvailableContext = new RawContextKey<boolean>('multiDiffEditorFileListAvailable', false);
export const MultiDiffEditorFileListEnabledContext = new RawContextKey<boolean>('multiDiffEditorFileListEnabled', false);
export const MultiDiffEditorFileListFocusedContext = new RawContextKey<boolean>('multiDiffEditorFileListFocus', false);
export type MultiDiffEditorFileListViewMode = 'list' | 'tree';
export const MultiDiffEditorFileListViewModeContext = new RawContextKey<MultiDiffEditorFileListViewMode>('multiDiffEditorFileListViewMode', 'list');
export const MultiDiffEditorFilesViewMenu = new MenuId('MultiDiffEditorFilesView');
export const MultiDiffEditorFileListContextMenu = new MenuId('MultiDiffEditorFileListContext');

const fileListHiddenKey = 'multiDiffEditor.fileListHidden';
const fileListViewModeKey = 'multiDiffEditor.fileListViewMode';

export function getToggleMultiDiffEditorFileListTitle() {
	return localize2('multiDiff.toggleFileList', 'Toggle Changed Files');
}

export function getMultiDiffEditorFilesViewTitle() {
	return localize2('multiDiff.filesView', 'Files View');
}

export function getMultiDiffEditorFileListViewMode(storage: IStorageService): MultiDiffEditorFileListViewMode | undefined {
	const mode = storage.get(fileListViewModeKey, StorageScope.PROFILE);
	return mode === 'tree' || mode === 'list' ? mode : undefined;
}

export function setMultiDiffEditorFileListViewMode(storage: IStorageService, mode: MultiDiffEditorFileListViewMode): void {
	storage.store(fileListViewModeKey, mode, StorageScope.PROFILE, StorageTarget.USER);
}

export function isMultiDiffEditorFileListEnabled(storage: IStorageService): boolean {
	return !storage.getBoolean(fileListHiddenKey, StorageScope.PROFILE, true);
}

export function onDidChangeMultiDiffEditorFileList(storage: IStorageService, listener: () => void): IDisposable {
	return storage.onDidChangeValue(event => {
		if (event.scope === StorageScope.PROFILE && (event.key === fileListHiddenKey || event.key === fileListViewModeKey)) listener();
	});
}

export function toggleMultiDiffEditorFileList(storage: IStorageService): void {
	storage.store(fileListHiddenKey, isMultiDiffEditorFileListEnabled(storage), StorageScope.PROFILE, StorageTarget.USER);
}
