import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

/** Registered workspace file view used by the Explorer and other contributions. */
export const VIEW_ID = 'ash.explorer';
export const OpenEditorsFocusedContext = new RawContextKey<boolean>('openEditorsFocus', false);
export const ExplorerRootContext = new RawContextKey<boolean>('explorerResourceIsRoot', false);
export const ExplorerFolderContext = new RawContextKey<boolean>('explorerResourceIsFolder', false);

export enum SortOrder {
	Default = 'default',
	Mixed = 'mixed',
	FilesFirst = 'filesFirst',
	Type = 'type',
	Modified = 'modified',
	FoldersNestsFiles = 'foldersNestsFiles',
}

export enum LexicographicOptions {
	Default = 'default',
	Upper = 'upper',
	Lower = 'lower',
	Unicode = 'unicode',
}
