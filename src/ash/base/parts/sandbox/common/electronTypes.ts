/** Electron dialog contracts shared by the renderer and Main adapters. */
export interface MessageBoxOptions {
	message: string;
	type?: 'none' | 'info' | 'error' | 'question' | 'warning';
	buttons?: string[];
	defaultId?: number;
	/** Local cancellation capability; IPC transports cancellation as a separate operation. */
	signal?: AbortSignal;
	title?: string;
	detail?: string;
	checkboxLabel?: string;
	checkboxChecked?: boolean;
	textWidth?: number;
	cancelId?: number;
	noLink?: boolean;
	normalizeAccessKeys?: boolean;
}

export interface MessageBoxReturnValue {
	response: number;
	checkboxChecked: boolean;
}

export interface FileFilter {
	extensions: string[];
	name: string;
}

export interface OpenDialogOptions {
	title?: string;
	defaultPath?: string;
	buttonLabel?: string;
	filters?: FileFilter[];
	properties?: Array<'openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles' | 'createDirectory' | 'promptToCreate' | 'noResolveAliases' | 'treatPackageAsDirectory' | 'dontAddToRecent'>;
	message?: string;
	securityScopedBookmarks?: boolean;
}

export interface OpenDialogReturnValue {
	canceled: boolean;
	/** Empty when the dialog is cancelled. */
	filePaths: string[];
	bookmarks?: string[];
}

export interface SaveDialogOptions {
	title?: string;
	defaultPath?: string;
	buttonLabel?: string;
	filters?: FileFilter[];
	message?: string;
	nameFieldLabel?: string;
	showsTagField?: boolean;
	properties?: Array<'showHiddenFiles' | 'createDirectory' | 'treatPackageAsDirectory' | 'showOverwriteConfirmation' | 'dontAddToRecent'>;
	securityScopedBookmarks?: boolean;
}

export interface SaveDialogReturnValue {
	canceled: boolean;
	/** Empty when the dialog is cancelled. */
	filePath: string;
	bookmark?: string;
}
