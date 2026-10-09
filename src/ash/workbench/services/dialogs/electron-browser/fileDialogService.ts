import { URI } from '../../../../base/common/uri.js';
import type { OpenDialogOptions } from '../../../../base/parts/sandbox/common/electronTypes.js';
import { localize } from '../../../../nls.js';
import {
	IDialogService,
	type IFileDialogService,
	type IOpenDialogOptions,
	type ISaveDialogOptions,
} from '../../../../platform/dialogs/common/dialogs.js';
import type { INativeHostApi } from '../../../../platform/native/common/nativeHost.js';
import { INativeHostService } from '../../../common/services.js';
import { AbstractFileDialogService } from '../browser/abstractFileDialogService.js';

/** Selects a filesystem path in the desktop window that owns the editor. */
export class FileDialogService extends AbstractFileDialogService implements IFileDialogService {
	constructor(@INativeHostService private readonly host: INativeHostApi, @IDialogService dialogs: IDialogService) {
		super(() => dialogs);
	}

	async pickFileToSave(defaultUri: URI): Promise<URI | undefined> {
		return this.showSaveDialog({ defaultUri });
	}

	async showSaveDialog(options: ISaveDialogOptions): Promise<URI | undefined> {
		this.validateFileSystem(options.availableFileSystems, options.defaultUri);
		// Untitled editors carry only a suggested name in a root-level URI.
		// Pass that name to the system dialog without opening the filesystem root.
		const result = await this.host.showSaveDialog({
			...(options.defaultUri ? {
				...(options.defaultUri.path !== '/' && options.defaultUri.path.lastIndexOf('/') === 0
					? { defaultPath: options.defaultUri.fsPath.split(/[\\/]/).at(-1) }
					: { defaultPath: options.defaultUri.fsPath }),
			} : {}),
			title: options.title ?? localize('dialog.saveFileTitle', 'Save File'),
			...(options.saveLabel ? { buttonLabel: options.saveLabel } : {}),
			...(options.filters ? { filters: options.filters.map(filter => ({ name: filter.name, extensions: [...filter.extensions] })) } : {}),
		});
		return !result.canceled && result.filePath ? URI.file(result.filePath) : undefined;
	}

	async showOpenDialog(options: IOpenDialogOptions): Promise<readonly URI[] | undefined> {
		this.validateFileSystem(options.availableFileSystems, options.defaultUri);
		if (options.canSelectFiles === false && options.canSelectFolders !== true) {
			throw new TypeError('Open dialog must allow files or folders');
		}
		const properties: NonNullable<OpenDialogOptions['properties']> = [];
		if (options.canSelectFiles !== false) { properties.push('openFile'); }
		if (options.canSelectFolders === true) { properties.push('openDirectory'); }
		if (options.canSelectMany) { properties.push('multiSelections'); }
		const result = await this.host.showOpenDialog({
			properties,
			...(options.defaultUri ? { defaultPath: options.defaultUri.fsPath } : {}),
			title: options.title ?? localize('dialog.openFileTitle', 'Open File'),
			...(options.openLabel ? { buttonLabel: options.openLabel } : {}),
			...(options.filters ? { filters: options.filters.map(filter => ({ name: filter.name, extensions: [...filter.extensions] })) } : {}),
		});
		return !result.canceled && result.filePaths.length > 0 ? result.filePaths.map(path => URI.file(path)) : undefined;
	}

	private validateFileSystem(availableFileSystems: readonly string[] | undefined, defaultUri: URI | undefined): void {
		if (availableFileSystems && !availableFileSystems.includes('file')) throw new Error('This file dialog supports the file scheme only');
		if (defaultUri && defaultUri.scheme !== 'file') throw new Error('This file dialog supports the file scheme only');
	}
}
