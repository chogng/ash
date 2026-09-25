import { URI } from '../../../../base/common/uri.js';
import type {
	IFileDialogService,
	IOpenDialogOptions,
	ISaveDialogOptions,
} from '../../../../platform/dialogs/common/dialogs.js';
import type { INativeHostApi } from '../../../../platform/native/common/nativeHost.js';
import { INativeHostService } from '../../../common/services.js';

/** Selects a filesystem path in the desktop window that owns the editor. */
export class FileDialogService implements IFileDialogService {
	constructor(@INativeHostService private readonly host: INativeHostApi) {}

	async pickFileToSave(defaultUri: URI): Promise<URI | undefined> {
		return this.showSaveDialog({ defaultUri });
	}

	async showSaveDialog(options: ISaveDialogOptions): Promise<URI | undefined> {
		this.validateFileSystem(options.availableFileSystems, options.defaultUri);
		// Untitled editors carry only a suggested name in a root-level URI.
		// Pass that name to the system dialog without opening the filesystem root.
		const path = await this.host.saveFile({
			...(options.defaultUri ? {
				...(options.defaultUri.path !== '/' && options.defaultUri.path.lastIndexOf('/') === 0
					? { defaultName: options.defaultUri.fsPath.split(/[\\/]/).at(-1) }
					: { defaultPath: options.defaultUri.fsPath }),
			} : {}),
			...(options.title ? { title: options.title } : {}),
			...(options.saveLabel ? { buttonLabel: options.saveLabel } : {}),
			...(options.filters ? { filters: options.filters } : {}),
		});
		return path ? URI.file(path) : undefined;
	}

	async showOpenDialog(options: IOpenDialogOptions): Promise<readonly URI[] | undefined> {
		this.validateFileSystem(options.availableFileSystems, options.defaultUri);
		if (options.canSelectFiles === false && options.canSelectFolders !== true) {
			throw new TypeError('Open dialog must allow files or folders');
		}
		const paths = await this.host.pickFile({
			canSelectFiles: options.canSelectFiles !== false,
			canSelectFolders: options.canSelectFolders === true,
			...(options.canSelectMany ? { canSelectMany: true } : {}),
			...(options.defaultUri ? { defaultPath: options.defaultUri.fsPath } : {}),
			...(options.title ? { title: options.title } : {}),
			...(options.openLabel ? { buttonLabel: options.openLabel } : {}),
			...(options.filters ? { filters: options.filters } : {}),
		});
		return paths?.map(path => URI.file(path));
	}

	private validateFileSystem(availableFileSystems: readonly string[] | undefined, defaultUri: URI | undefined): void {
		if (availableFileSystems && !availableFileSystems.includes('file')) throw new Error('This file dialog supports the file scheme only');
		if (defaultUri && defaultUri.scheme !== 'file') throw new Error('This file dialog supports the file scheme only');
	}
}
