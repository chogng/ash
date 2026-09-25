import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import {
	DialogSeverity,
	type FileFilter,
	type IDialogService,
	type IFileDialogService,
	type IOpenDialogOptions,
	type ISaveDialogOptions,
} from '../../../../platform/dialogs/common/dialogs.js';
import type { HTMLFileSystemProvider } from '../../../../platform/files/browser/htmlFileSystemProvider.js';
import { FileKind, FileNotFoundError, type IFileService } from '../../../../platform/files/common/files.js';
import type { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import type { IWebWorkspaceClient, IWebWorkspaceDirectoryList } from '../../workspaces/browser/workspaceOpenService.js';

interface FileDialogHostBase {
	readonly quickInput: () => IQuickInputService;
	readonly fileService: () => IFileService;
	readonly workspaceRoot: () => URI | undefined;
}

function matchesFileFilters(name: string, filters: readonly FileFilter[]): boolean {
	const lowerName = name.toLocaleLowerCase('en-US');
	return filters.some(filter => filter.extensions.some(extension =>
		extension === '*' || lowerName.endsWith(`.${extension.toLocaleLowerCase('en-US')}`)
	));
}

type FileDialogHost = FileDialogHostBase & (
	| { readonly kind: 'local'; readonly provider: HTMLFileSystemProvider; readonly pickDirectory: (startIn?: FileSystemDirectoryHandle) => Promise<FileSystemDirectoryHandle> }
	| { readonly kind: 'server'; readonly client: IWebWorkspaceClient }
);

type ServerDirectoryItem = IQuickPickItem & (
	| { readonly kind: 'select'; readonly path: string }
	| { readonly kind: 'parent'; readonly path: string }
	| { readonly kind: 'directory'; readonly path: string }
	| { readonly kind: 'done'; readonly path: string }
);

type WorkspaceFileItem = IQuickPickItem & (
	| { readonly kind: 'file' | 'directory' | 'parent'; readonly resource: URI }
	| { readonly kind: 'navigate'; readonly resource: URI }
	| { readonly kind: 'done' }
);

/** Selects folders and Save As targets for a browser Workbench. */
export class FileDialogService implements IFileDialogService {
	constructor(private readonly host: FileDialogHost, private readonly dialogs: () => IDialogService) {}

	async showOpenDialog(options: IOpenDialogOptions): Promise<readonly URI[] | undefined> {
		this.validateFileSystem(options.availableFileSystems, options.defaultUri);
		if (options.canSelectFiles === false && options.canSelectFolders !== true) {
			throw new TypeError('Open dialog must allow files or folders');
		}
		if (options.canSelectFiles !== false) {
			return this.pickWorkspaceFiles(options);
		}
		if (this.host.kind === 'server') {
			const paths = await this.pickServerDirectories(this.host, options);
			return paths?.map(path => URI.file(path));
		}
		let startIn = options.defaultUri?.path.startsWith('/@browser/')
			? await this.host.provider.getDirectoryHandle(options.defaultUri)
			: undefined;
		const folders: URI[] = [];
		for (;;) {
			let handle: FileSystemDirectoryHandle;
			try {
				handle = await this.host.pickDirectory(startIn);
			} catch (error) {
				if (error instanceof DOMException && error.name === 'AbortError') return folders.length ? folders : undefined;
				throw error;
			}
			const folder = await this.host.provider.registerDirectoryHandle(handle);
			startIn = handle;
			if (!folders.some(selected => selected.toString() === folder.toString())) folders.push(folder);
			if (!options.canSelectMany) return folders;
			const more = await this.dialogs().confirm({
				message: localize('dialog.addAnotherFolder', 'Add another folder?'),
				primaryButton: localize('dialog.addFolder', 'Add Folder'),
				cancelButton: options.openLabel ?? localize('dialog.finishSelection', 'Done'),
			});
			if (!more.confirmed) return folders;
		}
	}

	async pickFileToSave(defaultUri: URI): Promise<URI | undefined> {
		return this.showSaveDialog({ defaultUri });
	}

	async showSaveDialog(options: ISaveDialogOptions): Promise<URI | undefined> {
		this.validateFileSystem(options.availableFileSystems, options.defaultUri);
		if (this.host.kind === 'server' && !this.host.workspaceRoot()) {
			throw new Error('Saving a file requires an open workspace');
		}
		const workspaceRoot = this.host.workspaceRoot();
		const filter = await this.chooseFileFilter(options.filters);
		if (options.filters?.length && !filter) return undefined;
		let defaultDirectory: URI | undefined;
		const defaultIsAccessible = options.defaultUri && (this.host.kind === 'local'
			? options.defaultUri.path.startsWith('/@browser/')
			: !!workspaceRoot && extUri.isEqualOrParent(options.defaultUri, workspaceRoot));
		if (options.defaultUri && defaultIsAccessible) {
			const parent = options.defaultUri.withPath(options.defaultUri.path.slice(0, options.defaultUri.path.lastIndexOf('/')));
			try {
				defaultDirectory = (await this.host.fileService().stat(options.defaultUri)).kind === FileKind.Directory
					? options.defaultUri
					: parent;
			} catch (error) {
				if (!(error instanceof FileNotFoundError)) throw error;
				defaultDirectory = parent;
			}
		}
		const directory = this.host.kind === 'local'
			? (await this.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, defaultUri: defaultDirectory }))?.[0]
			: defaultDirectory ?? workspaceRoot;
		if (!directory) return undefined;
		const defaultName = options.defaultUri && !extUri.isEqual(defaultDirectory, options.defaultUri)
			? options.defaultUri.fsPath.split(/[\\/]/).at(-1) ?? ''
			: '';
		for (;;) {
			const result = await this.dialogs().input({
				title: options.title ?? localize('dialog.saveFileTitle', 'Save File'),
				message: localize('dialog.saveFileName', 'File name'),
				inputs: [{ value: defaultName }],
				primaryButton: options.saveLabel,
			});
			if (!result.confirmed) return undefined;
			const name = result.values?.[0]?.trim() ?? '';
			if (name && name !== '.' && name !== '..' && !/[\\/]/.test(name)) {
				if (filter && !matchesFileFilters(name, [filter])) {
					await this.dialogs().showMessage({ severity: DialogSeverity.Error, message: localize('dialog.fileTypeMismatch', 'Choose a file name matching the selected file types.') });
					continue;
				}
				const target = directory.withPath(`${directory.path.replace(/\/$/, '')}/${encodeURIComponent(name)}`);
				let kind: FileKind;
				try {
					kind = (await this.host.fileService().stat(target)).kind;
				} catch (error) {
					if (error instanceof FileNotFoundError) return target;
					throw error;
				}
				if (kind !== FileKind.File) {
					await this.dialogs().showMessage({
						severity: DialogSeverity.Error,
						message: localize('dialog.saveTargetNotFile', 'Choose a file name, not a folder.'),
					});
					continue;
				}
				const decision = await this.dialogs().confirm({
					message: localize('dialog.replaceExistingFile', 'Replace the existing file {0}?', name),
					primaryButton: localize('dialog.replaceFile', 'Replace'),
				});
				return decision.confirmed ? target : undefined;
			}
			await this.dialogs().showMessage({
				severity: DialogSeverity.Error,
				message: localize('dialog.invalidFileName', 'Enter a file name without a path separator.'),
			});
		}
	}

	private validateFileSystem(availableFileSystems: readonly string[] | undefined, defaultUri: URI | undefined): void {
		if (availableFileSystems && !availableFileSystems.includes('file')) throw new Error('This file dialog supports the file scheme only');
		if (defaultUri && defaultUri.scheme !== 'file') throw new Error('This file dialog supports the file scheme only');
	}

	private async pickWorkspaceFiles(options: IOpenDialogOptions): Promise<readonly URI[] | undefined> {
		const root = this.host.workspaceRoot();
		if (!root) {
			await this.dialogs().showMessage({
				severity: DialogSeverity.Warning,
				message: localize('dialog.openFileRequiresFolder', 'Open a folder to choose a file.'),
			});
			return undefined;
		}
		const filter = await this.chooseFileFilter(options.filters);
		if (options.filters?.length && !filter) return undefined;
		const initial = options.defaultUri && extUri.isEqualOrParent(options.defaultUri, root) ? options.defaultUri : root;
		let directory = initial;
		if (initial !== root) {
			try {
				if ((await this.host.fileService().stat(initial)).kind !== FileKind.Directory) directory = initial.withPath(initial.path.slice(0, initial.path.lastIndexOf('/')));
			} catch (error) {
				if (!(error instanceof FileNotFoundError)) throw error;
				directory = root;
			}
		}
		const selected = new Map<string, URI>();
		for (;;) {
			const entries = await this.host.fileService().readDirectory(directory);
			const items: WorkspaceFileItem[] = [
				...(options.canSelectMany && selected.size ? [{ kind: 'done' as const, label: `${options.openLabel ?? localize('dialog.finishSelection', 'Done')} (${selected.size})` }] : []),
				...(directory.toString() === root.toString() ? [] : [{
					kind: 'parent' as const,
					resource: directory.withPath(directory.path.slice(0, directory.path.lastIndexOf('/'))),
					label: '..',
				}]),
				...entries.filter(entry => entry.kind === FileKind.Directory).map(entry => ({
					kind: 'directory' as const, resource: entry.resource, label: entry.name,
					...(options.canSelectFolders ? { buttons: [{ id: 'navigate', label: localize('dialog.openFolder', 'Open Folder') }] } : {}),
				})),
				...(options.canSelectFiles === false ? [] : entries.filter(entry => entry.kind === FileKind.File && (!filter || matchesFileFilters(entry.name, [filter]))).map(entry => ({ kind: 'file' as const, resource: entry.resource, label: entry.name }))),
			];
			const choice = await this.showWorkspaceFiles(this.host.quickInput(), directory, items, options, selected);
			if (!choice) return undefined;
			if (choice.kind === 'done') return [...selected.values()];
			if (choice.kind === 'file' || choice.kind === 'directory' && options.canSelectFolders === true) {
				if (!options.canSelectMany) return [choice.resource];
				const key = choice.resource.toString();
				if (selected.has(key)) selected.delete(key);
				else selected.set(key, choice.resource);
				continue;
			}
			directory = choice.resource;
		}
	}

	private showWorkspaceFiles(quickInput: IQuickInputService, directory: URI, items: readonly WorkspaceFileItem[], options: IOpenDialogOptions, selected: ReadonlyMap<string, URI>): Promise<WorkspaceFileItem | undefined> {
		const picker = quickInput.createQuickPick<WorkspaceFileItem>();
		const disposables = new DisposableStore();
		disposables.add(picker);
		picker.items = items.map(item => {
			if (item.kind === 'done' || item.kind === 'parent' || item.kind === 'navigate') return item;
			const selectable = item.kind === 'file' || options.canSelectFolders === true;
			if (!selectable) return item;
			return {
				...item,
				label: options.canSelectMany
					? `${selected.has(item.resource.toString()) ? localize('dialog.deselect', 'Deselect') : localize('dialog.select', 'Select')} ${item.label}`
					: options.openLabel ? `${options.openLabel} ${item.label}` : item.label,
			};
		});
		picker.placeholder = directory.fsPath;
		picker.ariaLabel = options.title ?? localize('dialog.chooseFile', 'Choose a file');
		return new Promise(resolve => {
			let settled = false;
			const finish = (item: WorkspaceFileItem | undefined): void => {
				if (settled) return;
				settled = true;
				disposables.dispose();
				resolve(item);
			};
			disposables.add(picker.onDidAccept(item => finish(item)));
			disposables.add(picker.onDidTriggerItemButton(({ item, button }) => {
				if (button.id === 'navigate' && item.kind === 'directory') finish({ kind: 'navigate', resource: item.resource, label: item.label });
			}));
			disposables.add(picker.onDidHide(() => finish(undefined)));
			picker.show();
		});
	}

	private async chooseFileFilter(filters: readonly FileFilter[] | undefined): Promise<FileFilter | undefined> {
		if (!filters?.length) return undefined;
		if (filters.length === 1) return filters[0];
		const picker = this.host.quickInput().createQuickPick<IQuickPickItem & { readonly filter: FileFilter }>();
		const disposables = new DisposableStore();
		disposables.add(picker);
		picker.ariaLabel = localize('dialog.chooseFileType', 'Choose a file type');
		picker.items = filters.map(filter => ({ filter, label: filter.name, description: filter.extensions.map(extension => `*.${extension}`).join(', ') }));
		return new Promise(resolve => {
			let settled = false;
			const finish = (filter: FileFilter | undefined): void => {
				if (settled) return;
				settled = true;
				disposables.dispose();
				resolve(filter);
			};
			disposables.add(picker.onDidAccept(item => finish(item.filter)));
			disposables.add(picker.onDidHide(() => finish(undefined)));
			picker.show();
		});
	}

	private async pickServerDirectories(host: Extract<FileDialogHost, { kind: 'server' }>, options: IOpenDialogOptions): Promise<readonly string[] | undefined> {
		let path = options.defaultUri?.fsPath ?? '';
		const selected = new Set<string>();
		for (;;) {
			const listing = await host.client.list(path);
			const choice = await this.showServerDirectory(host.quickInput(), listing, options, selected);
			if (!choice) return undefined;
			if (choice.kind === 'done') return [...selected];
			if (choice.kind === 'select') {
				if (!options.canSelectMany) return [choice.path];
				if (selected.has(choice.path)) selected.delete(choice.path);
				else selected.add(choice.path);
				continue;
			}
			path = choice.path;
		}
	}

	private showServerDirectory(quickInput: IQuickInputService, listing: IWebWorkspaceDirectoryList, options: IOpenDialogOptions, selected: ReadonlySet<string>): Promise<ServerDirectoryItem | undefined> {
		const picker = quickInput.createQuickPick<ServerDirectoryItem>();
		const disposables = new DisposableStore();
		disposables.add(picker);
		picker.placeholder = listing.path;
		picker.ariaLabel = options.title ?? localize({ bundle: 'ash', key: 'workbench.serverFolderChoose' }, 'Choose a server folder');
		picker.items = [
			...(options.canSelectMany && selected.size ? [{ kind: 'done' as const, path: listing.path, label: `${options.openLabel ?? localize('dialog.finishSelection', 'Done')} (${selected.size})` }] : []),
			{ kind: 'select', path: listing.path, label: options.canSelectMany ? `${selected.has(listing.path) ? localize('dialog.deselect', 'Deselect') : localize('dialog.select', 'Select')} ${listing.path}` : options.openLabel ?? localize({ bundle: 'ash', key: 'workbench.serverFolderSelect' }, 'Select this folder'), description: listing.path },
			...(listing.parent ? [{ kind: 'parent' as const, path: listing.parent, label: '..', description: listing.parent }] : []),
			...listing.directories.map(directory => ({ kind: 'directory' as const, path: directory.path, label: directory.name })),
		];
		return new Promise(resolve => {
			let settled = false;
			const finish = (item: ServerDirectoryItem | undefined): void => {
				if (settled) return;
				settled = true;
				disposables.dispose();
				resolve(item);
			};
			disposables.add(picker.onDidAccept(item => finish(item)));
			disposables.add(picker.onDidHide(() => finish(undefined)));
			picker.show();
		});
	}
}
