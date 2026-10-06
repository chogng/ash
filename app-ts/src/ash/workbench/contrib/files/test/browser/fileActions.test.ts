import type { IResourceEditorInput } from '../../../../common/editor.js';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { isMenuItem, MenuId, MenusRegistry } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { FileEditorInput } from '../../browser/editors/fileEditorInput.js';
import { REVEAL_IN_EXPLORER_COMMAND_ID } from '../../browser/fileConstants.js';
import { MultipleEditorsSelectedInGroupContext, ResourceSchemeContext } from '../../../../common/contextkeys.js';
import { createBinaryDiffEditorInput, createDiffEditorInput } from '../../../../common/editor/diffEditorInput.js';
import { JSDOM } from 'jsdom';
import { setARIAContainer } from '../../../../../base/browser/ui/aria/aria.js';
import { URI } from '../../../../../base/common/uri.js';
import { Schemas } from '../../../../../base/common/network.js';
import { IClipboardService, type IClipboardResources } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IDialogService, type IConfirmationDialogOptions } from '../../../../../platform/dialogs/common/dialogs.js';
import { Event } from '../../../../../base/common/event.js';
import { IFileService, FileKind, FileNotFoundError, type IFileService as FileServiceContract } from '../../../../../platform/files/common/files.js';
import { ISystemFileTransferService } from '../../../../../platform/files/common/systemFileTransferService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IQuickInputService, type IQuickInputService as QuickInputServiceContract } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IEditorService, type IEditorService as EditorServiceContract } from '../../../../services/editor/common/editorService.js';
import { WorkspaceContextService } from '../../../../services/workspaces/browser/workspaceContextService.js';
import type { IEditorPart as EditorPartContract } from '../../../../browser/parts/editor/editorPart.js';
import { COPY_PATH_COMMAND_ID, COPY_RELATIVE_PATH_COMMAND_ID, OPEN_FILE_COMMAND_ID, SAVE_FILE_COMMAND_ID } from '../../browser/fileConstants.js';
import { CANCEL_CUT_COMMAND_ID, COPY_FILE_COMMAND_ID, CUT_FILE_COMMAND_ID, DELETE_FILE_COMMAND_ID, DOWNLOAD_COMMAND_ID, NEW_FILE_COMMAND_ID, NEW_FOLDER_COMMAND_ID, OPEN_TO_SIDE_COMMAND_ID, PASTE_FILE_COMMAND_ID, RENAME_FILE_COMMAND_ID } from '../../browser/fileActions.js';
import { IExplorerService } from '../../browser/files.js';
import { ExplorerService } from '../../browser/explorerService.js';
import { ExplorerItem } from '../../common/explorerModel.js';
import { INativeHostService } from '../../../../common/services.js';
import type { INativeHostApi } from '../../../../../platform/native/common/nativeHost.js';
import { REVEAL_IN_OS_COMMAND_ID } from '../../electron-browser/fileActions.contribution.js';
import { NATIVE_HOST_REVEAL_FILE_CHANNEL } from '../../../../../platform/native/common/nativeHost.js';
import { nativeHostIpcRoutes, type INativeHostMainService } from '../../../../../platform/native/electron-main/nativeHostIpc.js';

// URI paths use '/' on every host; URI.file() interprets filesystem separators for the current OS.
const fileCommandRoots = [
	{ name: 'POSIX', uri: 'file:///project' },
	{ name: 'Windows drive', uri: 'file:///C:/project' },
	{ name: 'UNC', uri: 'file://fileserver/share/project' },
] as const;

test('Save File command saves the active editor', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
	Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.window.document });
	try {
		const { IEditorPart } = await import('../../../../browser/parts/editor/editorPart.js');
		await import('../../browser/fileActions.contribution.js');
		let saves = 0;
		const services = new InstantiationService();
		services.registerInstance(IEditorPart, {
			saveActiveEditor: async () => { saves += 1; },
		} as unknown as EditorPartContract);
		using commands = new CommandService(services);

		await commands.executeCommand(SAVE_FILE_COMMAND_ID);

		assert.equal(saves, 1);
	} finally {
		if (previousDocument) {
			Object.defineProperty(globalThis, 'document', previousDocument);
		} else {
			Reflect.deleteProperty(globalThis, 'document');
		}
		browser.window.close();
	}
});

test('Open File command opens every file selected by the dialog', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
	Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.window.document });
	try {
		await import('../../browser/fileActions.contribution.js');
		const resources = [URI.file('/work/one.md'), URI.file('/work/two.md')];
		const opened: URI[] = [];
		const services = new InstantiationService();
		services.registerInstance(IFileDialogService, {
			pickFileToSave: async () => { throw new Error('Unexpected Save As'); },
			showSaveConfirm: async () => { throw new Error('Unexpected save confirmation'); },
			showSaveDialog: async () => { throw new Error('Unexpected save dialog'); },
			showOpenDialog: async options => {
				assert.equal(options.canSelectMany, true);
				return resources;
			},
		});
		services.registerInstance(IEditorService, { openEditor: async input => { opened.push(input.resource); } } as EditorServiceContract);
		using commands = new CommandService(services);
		await commands.executeCommand(OPEN_FILE_COMMAND_ID);
		assert.deepEqual(opened, resources);
	} finally {
		if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
		else Reflect.deleteProperty(globalThis, 'document');
		browser.window.close();
	}
});

for (const fileRoot of fileCommandRoots) {
	test(`New File command creates and opens a file in the active workspace folder (${fileRoot.name})`, async () => {
		const browser = new JSDOM('<!doctype html><body></body>');
		const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
		Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.window.document });
		try {
			await import('../../browser/fileActions.contribution.js');
			const root = URI.parse(fileRoot.uri);
			const created: URI[] = [];
			const opened: URI[] = [];
			using workspace = new WorkspaceContextService({ id: 'project', uri: root });
			const services = new InstantiationService();
			using explorerService = createExplorerService(workspace);
			services.registerInstance(IWorkspaceContextService, workspace);
			services.registerInstance(IExplorerService, explorerService);
			services.registerInstance(IQuickInputService, {
				input: async options => {
					assert.equal(options.title, 'New File Name');
					assert.equal(await options.validateInput?.('../escape'), 'Enter a file name without path separators.');
					assert.equal(await options.validateInput?.('new %中.txt'), undefined);
					return 'new %中.txt';
				},
			} as QuickInputServiceContract);
			services.registerInstance(IFileService, {
				onDidChangeFiles: Event.None,
				createFile: async (resource, existing) => {
					assert.equal(existing, 'error');
					created.push(resource);
					return { resource, kind: FileKind.File, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined };
				},
			} as FileServiceContract);
			services.registerInstance(IEditorService, {
				activeEditor: undefined,
				openEditor: async input => { opened.push(input.resource); },
			} as EditorServiceContract);
			using commands = new CommandService(services);

			await commands.executeCommand(NEW_FILE_COMMAND_ID);

			assert.deepEqual(created.map(resource => resource.toString()), [`${fileRoot.uri}/new%20%25%E4%B8%AD.txt`]);
			assert.deepEqual(opened.map(resource => resource.toString()), created.map(resource => resource.toString()));

			using viewRegistration = explorerService.registerView({
				getContext: () => [new ExplorerItem(URI.parse(`${fileRoot.uri}/src`), 'src', FileKind.Directory)],
				getAccessibleContent: () => '',
				selectResource: async () => { },
				focus() { },
			});
			await commands.executeCommand(NEW_FILE_COMMAND_ID);
			assert.equal(created.at(-1)?.toString(), `${fileRoot.uri}/src/new%20%25%E4%B8%AD.txt`);
		} finally {
			if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
			else Reflect.deleteProperty(globalThis, 'document');
			browser.window.close();
		}
	});
}

test('New Folder command creates a directory under the selected folder', async () => {
	await import('../../browser/fileActions.contribution.js');
	const root = URI.file('/project');
	const folder = URI.file('/project/src');
	const created: URI[] = [];
	using workspace = new WorkspaceContextService({ id: 'project', uri: root });
	using explorer = createExplorerService(workspace);
	using registration = explorer.registerView({
		getContext: () => [new ExplorerItem(folder, 'src', FileKind.Directory)],
		getAccessibleContent: () => '',
		selectResource: async () => { },
		focus() { },
	});
	using services = new InstantiationService();
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IExplorerService, explorer);
	services.registerInstance(IEditorService, { activeEditor: undefined } as EditorServiceContract);
	services.registerInstance(IQuickInputService, {
		input: async options => {
			assert.equal(options.title, 'New Folder Name');
			assert.equal(await options.validateInput?.('../escape'), 'Enter a name without path separators.');
			return 'generated';
		},
	} as QuickInputServiceContract);
	services.registerInstance(IFileService, {
		createDirectory: async resource => {
			created.push(resource);
			return { resource, kind: FileKind.Directory, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined };
		},
	} as FileServiceContract);
	using commands = new CommandService(services);

	await commands.executeCommand(NEW_FOLDER_COMMAND_ID);
	assert.deepEqual(created, [URI.file('/project/src/generated')]);
});

test('Explorer copy and cut paste selected files with conflict names', async () => {
	await import('../../browser/fileActions.contribution.js');
	const root = URI.file('/project');
	const first = new ExplorerItem(URI.file('/project/one.txt'), 'one.txt', FileKind.File);
	const second = new ExplorerItem(URI.file('/project/two.txt'), 'two.txt', FileKind.File);
	const folder = new ExplorerItem(URI.file('/project/dest'), 'dest', FileKind.Directory);
	let selected: readonly ExplorerItem[] = [first, second];
	using workspace = new WorkspaceContextService({ id: 'project', uri: root });
	using explorer = createExplorerService(workspace);
	using registration = explorer.registerView({ getContext: () => selected, getAccessibleContent: () => '', selectResource: async () => { }, focus() { } });
	const existing = new Set(['/project/one.txt', '/project/two.txt', '/project/dest', '/project/dest/one.txt']);
	const copied: string[] = [];
	const renamed: string[] = [];
	let resourceClipboard: IClipboardResources = { resources: [], operation: 'copy' };
	using services = new InstantiationService();
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IExplorerService, explorer);
	services.registerInstance(IClipboardService, {
		readText: async () => '',
		writeText: async () => { },
		readResources: async () => resourceClipboard,
		writeResources: async (resources, operation) => { resourceClipboard = { resources: [...resources], operation }; },
		hasResources: async () => resourceClipboard.resources.length > 0,
	});
	services.registerInstance(ISystemFileTransferService, { pasteSystemFiles: async () => false });
	services.registerInstance(IFileService, {
		stat: async (resource: URI) => { if (!existing.has(resource.path)) throw new FileNotFoundError(resource); return { resource, kind: FileKind.File, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined }; },
		copy: async (source: URI, target: URI) => { copied.push(`${source.path} -> ${target.path}`); existing.add(target.path); },
		rename: async (source: URI, target: URI) => { renamed.push(`${source.path} -> ${target.path}`); existing.delete(source.path); existing.add(target.path); },
	} as unknown as FileServiceContract);
	using commands = new CommandService(services);
	await commands.executeCommand(COPY_FILE_COMMAND_ID);
	selected = [folder];
	await commands.executeCommand(PASTE_FILE_COMMAND_ID);
	assert.deepEqual(copied, ['/project/one.txt -> /project/dest/one copy.txt', '/project/two.txt -> /project/dest/two.txt']);
	selected = [second];
	await commands.executeCommand(CUT_FILE_COMMAND_ID);
	selected = [folder];
	await commands.executeCommand(PASTE_FILE_COMMAND_ID);
	assert.deepEqual(renamed, ['/project/two.txt -> /project/dest/two copy.txt']);
	assert.equal(explorer.getToCopy().items.length, 0);
	selected = [first];
	await commands.executeCommand(CUT_FILE_COMMAND_ID);
	resourceClipboard = { resources: resourceClipboard.resources, operation: 'copy' };
	await commands.executeCommand(CANCEL_CUT_COMMAND_ID);
	assert.equal(explorer.getToCopy().items.length, 0);
	assert.deepEqual(resourceClipboard, { resources: [first.resource], operation: 'copy' });
	selected = [new ExplorerItem(URI.file('/project/src'), 'src', FileKind.Directory), new ExplorerItem(URI.file('/project/src/child.txt'), 'child.txt', FileKind.File)];
	await commands.executeCommand(COPY_FILE_COMMAND_ID);
	assert.deepEqual(explorer.getToCopy().items.map(item => item.name), ['src']);
});

test('Explorer paste keeps copy and cut operations across windows', async () => {
	await import('../../browser/fileActions.contribution.js');
	const root = URI.file('/project');
	const source = URI.file('/project/100% ready.bin');
	const destination = URI.file('/project/destination');
	let pasteDestination = destination;
	let clipboardResources: IClipboardResources = { resources: [], operation: 'copy' };
	const clipboard = {
		readText: async () => '',
		writeText: async () => { },
		readResources: async () => clipboardResources,
		writeResources: async (resources: readonly URI[], operation: 'copy' | 'move') => { clipboardResources = { resources: [...resources], operation }; },
		hasResources: async () => clipboardResources.resources.length > 0,
	};
	using workspace = new WorkspaceContextService({ id: 'project', uri: root });
	using first = createExplorerService(workspace);
	using second = createExplorerService(workspace);
	using firstView = first.registerView({ getContext: () => [new ExplorerItem(source, '100% ready.bin', FileKind.File)], getAccessibleContent: () => '', selectResource: async () => { }, focus() { } });
	using secondView = second.registerView({ getContext: () => [new ExplorerItem(pasteDestination, 'destination', FileKind.Directory)], getAccessibleContent: () => '', selectResource: async () => { }, focus() { } });
	using firstServices = new InstantiationService();
	firstServices.registerInstance(IWorkspaceContextService, workspace);
	firstServices.registerInstance(IExplorerService, first);
	firstServices.registerInstance(IClipboardService, clipboard);
	using firstCommands = new CommandService(firstServices);
	await firstCommands.executeCommand(COPY_FILE_COMMAND_ID);

	const operations: string[] = [];
	using secondServices = new InstantiationService();
	secondServices.registerInstance(IWorkspaceContextService, workspace);
	secondServices.registerInstance(IExplorerService, second);
	secondServices.registerInstance(IClipboardService, clipboard);
	secondServices.registerInstance(ISystemFileTransferService, { pasteSystemFiles: async () => false });
	secondServices.registerInstance(IFileService, {
		stat: async (resource: URI) => {
			if (resource.toString() === source.toString()) return { resource, kind: FileKind.File, sizeBytes: 3, readonly: false, modifiedAtMillis: undefined };
			throw new FileNotFoundError(resource);
		},
		copy: async (from: URI, to: URI) => { operations.push(`copy ${from.path} -> ${to.path}`); },
		rename: async (from: URI, to: URI) => { operations.push(`move ${from.path} -> ${to.path}`); },
	} as unknown as FileServiceContract);
	using secondCommands = new CommandService(secondServices);
	await secondCommands.executeCommand(PASTE_FILE_COMMAND_ID);
	assert.deepEqual(operations, ['copy /project/100% ready.bin -> /project/destination/100% ready.bin']);
	await firstCommands.executeCommand(CUT_FILE_COMMAND_ID);
	pasteDestination = URI.file('/project/other');
	await secondCommands.executeCommand(PASTE_FILE_COMMAND_ID);
	assert.deepEqual(operations, [
		'copy /project/100% ready.bin -> /project/destination/100% ready.bin',
		'move /project/100% ready.bin -> /project/other/100% ready.bin',
	]);
});

test('Explorer cut across nested workspace roots copies before deleting the source', async () => {
	await import('../../browser/fileActions.contribution.js');
	const source = URI.file('/project/nested/main.ts');
	const destination = URI.file('/project/destination');
	let selected = new ExplorerItem(source, 'main.ts', FileKind.File);
	using workspace = new WorkspaceContextService({
		id: 'project',
		folders: [
			{ id: 'outer', uri: URI.file('/project'), name: 'project', index: 0 },
			{ id: 'nested', uri: URI.file('/project/nested'), name: 'nested', index: 1 },
		],
	});
	using explorer = createExplorerService(workspace);
	using view = explorer.registerView({ getContext: () => [selected], getAccessibleContent: () => '', selectResource: async () => { }, focus() { } });
	let clipboardResources: IClipboardResources = { resources: [], operation: 'copy' };
	const operations: string[] = [];
	using services = new InstantiationService();
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IExplorerService, explorer);
	services.registerInstance(IClipboardService, {
		readText: async () => '',
		writeText: async () => { },
		readResources: async () => clipboardResources,
		writeResources: async (resources, operation) => { clipboardResources = { resources, operation }; },
		hasResources: async () => clipboardResources.resources.length > 0,
	});
	services.registerInstance(ISystemFileTransferService, { pasteSystemFiles: async () => false });
	services.registerInstance(IFileService, {
		stat: async (resource: URI) => { throw new FileNotFoundError(resource); },
		copy: async () => { operations.push('copy'); },
		delete: async () => { operations.push('delete'); },
		rename: async () => { operations.push('rename'); },
	} as unknown as FileServiceContract);
	using commands = new CommandService(services);

	await commands.executeCommand(CUT_FILE_COMMAND_ID);
	selected = new ExplorerItem(destination, 'destination', FileKind.Directory);
	await commands.executeCommand(PASTE_FILE_COMMAND_ID);

	assert.deepEqual(operations, ['copy', 'delete']);
});

test('Explorer paste forwards copy and move requests to the system file transfer service', async () => {
	await import('../../browser/fileActions.contribution.js');
	const browser = new JSDOM('<!doctype html><body></body>');
	try {
		setARIAContainer(browser.window.document.body);
		const destination = URI.file('/project/destination');
		using workspace = new WorkspaceContextService({ id: 'project', uri: URI.file('/project') });
		using explorer = createExplorerService(workspace);
		using view = explorer.registerView({ getContext: () => [new ExplorerItem(destination, 'destination', FileKind.Directory)], getAccessibleContent: () => '', selectResource: async () => { }, focus() { } });
		const pastes: { directory: string; moveRequested: boolean; }[] = [];
		using services = new InstantiationService();
		services.registerInstance(IWorkspaceContextService, workspace);
		services.registerInstance(IExplorerService, explorer);
		services.registerInstance(IClipboardService, {
			readResources: async () => ({ resources: [], operation: 'copy' }),
		} as unknown as IClipboardService);
		services.registerInstance(ISystemFileTransferService, {
			pasteSystemFiles: async (directory, moveRequested) => { pastes.push({ directory: directory.path, moveRequested }); return true; },
		});
		services.registerInstance(IFileService, {} as FileServiceContract);
		using commands = new CommandService(services);

		await commands.executeCommand(PASTE_FILE_COMMAND_ID);
		await commands.executeCommand(PASTE_FILE_COMMAND_ID, undefined, true);

		assert.deepEqual(pastes, [
			{ directory: '/project/destination', moveRequested: false },
			{ directory: '/project/destination', moveRequested: true },
		]);
	} finally {
		browser.window.close();
	}
});

test('Explorer paste imports exact bytes from the system file list', async () => {
	await import('../../browser/fileActions.contribution.js');
	const browser = new JSDOM('<!doctype html><body></body>');
	const previousFileList = Object.getOwnPropertyDescriptor(globalThis, 'FileList');
	Object.defineProperty(globalThis, 'FileList', { configurable: true, value: browser.window.FileList });
	try {
		const root = URI.file('/project');
		const destination = URI.file('/project/destination');
		const bytes = new Uint8Array([0, 255, 42]);
		const file = { name: 'picture.bin', arrayBuffer: async () => bytes.buffer } as File;
		const fileList = Object.create(browser.window.FileList.prototype) as FileList;
		Object.defineProperties(fileList, {
			0: { value: file },
			length: { value: 1 },
			[Symbol.iterator]: { value: function* () { yield file; } },
		});
		using workspace = new WorkspaceContextService({ id: 'project', uri: root });
		using explorer = createExplorerService(workspace);
		using view = explorer.registerView({ getContext: () => [new ExplorerItem(destination, 'destination', FileKind.Directory)], getAccessibleContent: () => '', selectResource: async () => { }, focus() { } });
		const writes: { resource: string; bytes: number[]; }[] = [];
		const attemptedTransfers: string[] = [];
		using services = new InstantiationService();
		services.registerInstance(IWorkspaceContextService, workspace);
		services.registerInstance(IExplorerService, explorer);
		services.registerInstance(IClipboardService, {
			readResources: async () => ({ resources: [], operation: 'copy' }),
		} as unknown as IClipboardService);
		services.registerInstance(ISystemFileTransferService, { pasteSystemFiles: async directory => { attemptedTransfers.push(directory.path); return false; } });
		services.registerInstance(IFileService, {
			stat: async (resource: URI) => { throw new FileNotFoundError(resource); },
			writeFileBytes: async (resource: URI, content: Uint8Array) => {
				writes.push({ resource: resource.path, bytes: [...content] });
				return { stat: { resource, kind: FileKind.File, sizeBytes: content.length, readonly: false, modifiedAtMillis: undefined }, revision: 'copied' };
			},
		} as unknown as FileServiceContract);
		using commands = new CommandService(services);
		await commands.executeCommand(PASTE_FILE_COMMAND_ID, fileList);
		assert.deepEqual(attemptedTransfers, ['/project/destination']);
		assert.deepEqual(writes, [{ resource: '/project/destination/picture.bin', bytes: [0, 255, 42] }]);
	} finally {
		if (previousFileList) Object.defineProperty(globalThis, 'FileList', previousFileList);
		else Reflect.deleteProperty(globalThis, 'FileList');
		browser.window.close();
	}
});

test('Copy Path commands copy the active file and its workspace-relative path', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
	Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.window.document });
	try {
		await import('../../browser/fileActions.contribution.js');
		const root = URI.file('/project');
		const file = URI.file('/project/src/main.ts');
		const copied: string[] = [];
		using workspace = new WorkspaceContextService({ id: 'project', folders: [{ id: 'project', uri: root, name: 'project', index: 0 }] });
		const services = new InstantiationService();
		let activeEditor: IResourceEditorInput = { resource: file };
		services.registerInstance(IEditorService, {
			get activeEditor() { return activeEditor; },
		} as EditorServiceContract);
		services.registerInstance(IWorkspaceContextService, workspace);
		services.registerInstance(IClipboardService, {
			readText: async () => copied.at(-1) ?? '',
			writeText: async (value: string) => { copied.push(value); },
			readResources: async () => ({ resources: [], operation: 'copy' }),
			writeResources: async () => { },
			hasResources: async () => false,
		});
		using commands = new CommandService(services);

		await commands.executeCommand(COPY_PATH_COMMAND_ID);
		await commands.executeCommand(COPY_RELATIVE_PATH_COMMAND_ID);

		assert.deepEqual(copied, [file.fsPath, 'src/main.ts']);
		activeEditor = createDiffEditorInput({ resource: URI.parse('git-change:/src/main.ts?revision=1') }, { resource: file });
		await commands.executeCommand(COPY_PATH_COMMAND_ID);
		await commands.executeCommand(COPY_RELATIVE_PATH_COMMAND_ID);
		assert.deepEqual(copied.slice(2), [file.fsPath, 'src/main.ts']);
		activeEditor = createBinaryDiffEditorInput({ resource: URI.file('/project/before.bin') }, { resource: file });
		await commands.executeCommand(COPY_PATH_COMMAND_ID);
		await commands.executeCommand(COPY_RELATIVE_PATH_COMMAND_ID);
		assert.deepEqual(copied.slice(4), [file.fsPath, 'src/main.ts']);
		await assert.rejects(commands.executeCommand(COPY_RELATIVE_PATH_COMMAND_ID, URI.file('/outside/other.ts')), /outside the current workspace/);
		assert.equal(copied.length, 6);
	} finally {
		if (previousDocument) {
			Object.defineProperty(globalThis, 'document', previousDocument);
		} else {
			Reflect.deleteProperty(globalThis, 'document');
		}
		browser.window.close();
	}
});

for (const fileRoot of fileCommandRoots) {
	test(`Download File command preserves the active file bytes and filename (${fileRoot.name})`, async () => {
		const browser = new JSDOM('<!doctype html><body></body>');
		const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
		Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.window.document });
		try {
			await import('../../browser/fileActions.contribution.js');
			const resource = URI.parse(`${fileRoot.uri}/100%25%20payload.bin`);
			const reads: URI[] = [];
			let downloadedName: string | undefined;
			let downloadedBlob: Blob | undefined;
			browser.window.URL.createObjectURL = (blob: Blob) => {
				downloadedBlob = blob;
				return 'blob:ash-download';
			};
			browser.window.URL.revokeObjectURL = () => { };
			browser.window.HTMLAnchorElement.prototype.click = function () {
				downloadedName = this.download;
			};
			const services = new InstantiationService();
			services.registerInstance(IEditorService, { activeEditor: { resource } } as EditorServiceContract);
			services.registerInstance(IFileService, {
				readFileBytes: async requested => {
					reads.push(requested);
					return { resource: requested, bytes: new Uint8Array([0, 255, 42]), revision: 'r1' };
				},
			} as FileServiceContract);
			using commands = new CommandService(services);

			await commands.executeCommand(DOWNLOAD_COMMAND_ID);

			assert.equal(downloadedName, '100% payload.bin');
			assert.deepEqual(reads, [resource]);
			assert.deepEqual([...new Uint8Array(await downloadedBlob!.arrayBuffer())], [0, 255, 42]);
		} finally {
			if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
			else Reflect.deleteProperty(globalThis, 'document');
			browser.window.close();
		}
	});
}

test('Explorer menu commands rename, open beside the editor, and delete the selected file', async () => {
	await import('../../browser/fileActions.contribution.js');
	const root = URI.file('/project');
	const selected = URI.file('/project/old.ts');
	const renamed: string[] = [];
	const deleted: string[] = [];
	const opened: string[] = [];
	using workspace = new WorkspaceContextService({ id: 'project', uri: root });
	using explorer = createExplorerService(workspace);
	using registration = explorer.registerView({
		getContext: () => [new ExplorerItem(selected, 'old.ts', FileKind.File)],
		getAccessibleContent: () => '',
		selectResource: async () => { },
		focus() { },
	});
	using services = new InstantiationService();
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IExplorerService, explorer);
	services.registerInstance(IQuickInputService, {
		input: async options => {
			assert.equal(options.value, 'old.ts');
			assert.equal(await options.validateInput?.('../escape'), 'Enter a file name without path separators.');
			return 'new.ts';
		},
	} as QuickInputServiceContract);
	services.registerInstance(IFileService, {
		rename: async (source, target, existing) => {
			assert.equal(existing, 'error');
			renamed.push(`${source.toString()} -> ${target.toString()}`);
		},
		delete: async (resource, missing, mode) => {
			assert.equal(missing, 'error');
			assert.equal(mode, 'recursive');
			deleted.push(resource.toString());
		},
	} as FileServiceContract);
	services.registerInstance(IDialogService, {
		confirm: async (options: IConfirmationDialogOptions) => {
			assert.equal(options.message, 'Permanently delete old.ts?');
			return { confirmed: true };
		},
	} as unknown as IDialogService);
	services.registerInstance(IEditorService, {
		openEditor: async (input, options, target) => {
			assert.deepEqual(options, { pinned: true });
			assert.equal(target, 'sideGroup');
			opened.push(input.resource.toString());
		},
	} as EditorServiceContract);
	using commands = new CommandService(services);

	await commands.executeCommand(OPEN_TO_SIDE_COMMAND_ID);
	await commands.executeCommand(RENAME_FILE_COMMAND_ID);
	await commands.executeCommand(DELETE_FILE_COMMAND_ID);

	assert.deepEqual(opened, [selected.toString()]);
	assert.deepEqual(renamed, [`${selected.toString()} -> ${URI.file('/project/new.ts').toString()}`]);
	assert.deepEqual(deleted, [selected.toString()]);
});

test('Reveal in OS command sends the selected local file to the desktop host', async () => {
	const locations = [MenuId.ExplorerContext, MenuId.EditorTitleContext, MenuId.EditorTitle, MenuId.CommandPalette].filter(menu =>
		MenusRegistry.getMenuItems(menu).some(item => isMenuItem(item) && item.command.id === REVEAL_IN_OS_COMMAND_ID));
	assert.deepEqual(locations, [MenuId.ExplorerContext, MenuId.EditorTitleContext, MenuId.CommandPalette]);
	const root = URI.parse('file:///C:/project');
	const selected = URI.parse('file:///C:/project/src/main.ts');
	const other = URI.parse('file:///C:/project/other.ts');
	const revealed: string[] = [];
	using workspace = new WorkspaceContextService({ id: 'project', uri: root });
	using explorer = createExplorerService(workspace);
	using registration = explorer.registerView({
		getContext: () => [new ExplorerItem(selected, 'main.ts', FileKind.File)],
		getAccessibleContent: () => '',
		selectResource: async () => { },
		focus() { },
	});
	using services = new InstantiationService();
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IExplorerService, explorer);
	services.registerInstance(IEditorService, { activeEditor: undefined } as EditorServiceContract);
	services.registerInstance(INativeHostService, {
		revealFile: async path => { revealed.push(path); },
	} as INativeHostApi);
	using commands = new CommandService(services);

	await commands.executeCommand(REVEAL_IN_OS_COMMAND_ID);
	assert.deepEqual(revealed, [selected.fsPath]);
	await commands.executeCommand(REVEAL_IN_OS_COMMAND_ID, other);
	assert.deepEqual(revealed, [selected.fsPath, other.fsPath]);
});

test('Reveal file IPC validates the requested path before calling the desktop host', async () => {
	const revealed: string[] = [];
	const route = nativeHostIpcRoutes({ revealFile: path => { revealed.push(path); } } as INativeHostMainService)
		.find(candidate => candidate.channel === NATIVE_HOST_REVEAL_FILE_CHANNEL);
	assert.ok(route);
	assert.throws(() => route.validate('bad\0path'), /Invalid file path/);
	await route.invoke(route.validate('C:\\project\\main.ts'));
	assert.deepEqual(revealed, ['C:\\project\\main.ts']);
});

test('tab copy actions copy clicked and selected file paths without changing the active editor', async () => {
	await import('../../browser/fileActions.contribution.js');
	const active = new FileEditorInput(URI.file('/project/active.ts'));
	const clicked = new FileEditorInput(URI.file('/project/src/clicked.ts'));
	const second = new FileEditorInput(URI.file('/project/src/second.ts'));
	const group = { id: 'main', inputs: [active, clicked, second], selectedInputs: [active], editors: [active, clicked, second].map(input => ({ input })), activeInput: active };
	const copied: string[] = [];
	using workspace = new WorkspaceContextService({ id: 'project', uri: URI.file('/project') });
	using services = new InstantiationService();
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IEditorGroupsService, { getGroup: (id: string) => id === group.id ? group : undefined } as unknown as IEditorGroupsService);
	services.registerInstance(IEditorService, { activeEditor: active } as unknown as EditorServiceContract);
	services.registerInstance(IClipboardService, { writeText: async text => { copied.push(text); } } as IClipboardService);
	using commands = new CommandService(services);
	using context = new ContextKeyService();
	context.setContext(ResourceSchemeContext.key, clicked.resource.scheme);
	const menus = new MenuService(commands, context);
	const actions = menus.getMenuActions(MenuId.EditorTitleContext, { arg: { groupId: group.id, editorIndex: 1 } }).find(([name]) => name === '1_cutcopypaste')![1];
	assert.deepEqual(actions.map(action => action.id), [COPY_PATH_COMMAND_ID, COPY_RELATIVE_PATH_COMMAND_ID]);
	for (const action of actions) await action.run();
	group.selectedInputs = [clicked, second];
	for (const action of actions) await action.run();
	const separator = process.platform === 'win32' ? '\r\n' : '\n';
	assert.deepEqual(copied, [clicked.resource.fsPath, 'src/clicked.ts', [clicked.resource.fsPath, second.resource.fsPath].join(separator), ['src/clicked.ts', 'src/second.ts'].join(separator)]);
	assert.equal(group.activeInput, active);
	await assert.rejects(commands.executeCommand(COPY_PATH_COMMAND_ID, { groupId: 'missing' }), TypeError);
	assert.equal(copied.length, 4);
	context.setContext(ResourceSchemeContext.key, Schemas.untitled);
	assert.equal(menus.getMenuActions(MenuId.EditorTitleContext).some(([name]) => name === '1_cutcopypaste'), false);
});

test('Reveal tab menu groups both destinations and targets the clicked inactive file', async () => {
	await import('../../browser/fileActions.contribution.js');
	const active = new FileEditorInput(URI.file('/project/active.ts'));
	const clicked = new FileEditorInput(URI.file('/project/src/clicked.ts'));
	const group = { id: 'main', inputs: [active, clicked], selectedInputs: [active], editors: [{ input: active }, { input: clicked }], activeInput: active };
	const effects: unknown[] = [];
	using workspace = new WorkspaceContextService({ id: 'project', uri: URI.file('/project') });
	using explorer = createExplorerService(workspace);
	using view = explorer.registerView({
		getContext: () => [new ExplorerItem(active.resource, active.label, FileKind.File)],
		getAccessibleContent: () => '',
		selectResource: async (resource, reveal) => { effects.push(['select', resource?.toString(), reveal]); },
		focus() { },
	});
	using services = new InstantiationService();
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IExplorerService, explorer);
	services.registerInstance(IEditorService, { activeEditor: active } as unknown as EditorServiceContract);
	services.registerInstance(IEditorGroupsService, { getGroup: (id: string) => id === group.id ? group : undefined } as unknown as IEditorGroupsService);
	services.registerInstance(INativeHostService, { revealFile: async path => { effects.push(['finder', path]); } } as INativeHostApi);
	services.registerInstance(IViewsService, {
		openView: async (id: string) => {
			effects.push(['open', id]);
			return { id, focus: () => { effects.push(['focus']); }, isVisible: () => true, setVisible() { } };
		},
		focusView: async () => false,
		getViewWithId: () => null,
	} as unknown as IViewsService);
	using commands = new CommandService(services);
	using context = new ContextKeyService();
	context.setContext(ResourceSchemeContext.key, clicked.resource.scheme);
	context.setContext(MultipleEditorsSelectedInGroupContext.key, false);
	const menus = new MenuService(commands, context);
	const actions = menus.getMenuActions(MenuId.EditorTitleContext, { arg: { groupId: group.id, editorIndex: 1 } }).find(([name]) => name === '2_files')![1];
	assert.deepEqual(actions.map(action => action.id), [REVEAL_IN_OS_COMMAND_ID, REVEAL_IN_EXPLORER_COMMAND_ID]);
	for (const action of actions) await action.run();
	assert.deepEqual(effects, [['finder', clicked.resource.fsPath], ['open', 'ash.explorer'], ['select', clicked.resource.toString(), 'force'], ['focus']]);
	context.setContext(MultipleEditorsSelectedInGroupContext.key, true);
	assert.deepEqual(menus.getMenuActions(MenuId.EditorTitleContext).find(([name]) => name === '2_files')![1].map(action => action.enabled), [false, false]);
});

function createExplorerService(workspace: WorkspaceContextService): ExplorerService {
	return new ExplorerService(workspace, { onDidChangeFiles: Event.None } as FileServiceContract, explorerConfiguration);
}

const explorerConfiguration = new InMemoryConfigurationService();
suiteTeardown(() => explorerConfiguration.dispose());
