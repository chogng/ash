import { expectIconFontLoaded } from '../../../../../../../test/automation/iconFonts.js';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import '../../../../../editor/test/browser/testEditorDom.js';
import { OperatingSystem, isWindows, isMacintosh } from '../../../../../base/common/platform.js';
import { KeybindingResolver } from '../../../../../platform/keybinding/common/keybindingResolver.js';
import { getKeybindingLabel, KeybindingLabelStyle } from '../../../../../base/common/keybindingLabels.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { createDisconnectedRendererApi } from '../../../../browser/rendererApi.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IRendererHostService } from '../../../../../platform/renderer/common/rendererHost.js';
import '../../../../services/path/browser/pathService.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';
import { createSshRemoteWorkspaceUri } from '../../../../../platform/remote/common/remote.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import assert from 'node:assert/strict';
import { afterEach, suiteTeardown, test, suite, teardown } from 'mocha';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { IFilesConfigurationService } from '../../../../services/filesConfiguration/common/filesConfigurationService.js';
import { isMenuItem, MenuId, MenusRegistry } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { FileEditorInput } from '../../browser/editors/fileEditorInput.js';
import { REVEAL_IN_EXPLORER_COMMAND_ID } from '../../browser/fileConstants.js';
import { ActiveEditorPinnedContext, ActiveEditorStickyContext, EditorsVisibleContext, MultipleEditorsSelectedInGroupContext, ResourceSchemeContext } from '../../../../common/contextkeys.js';
import { createBinaryDiffEditorInput, createDiffEditorInput } from '../../../../common/editor/diffEditorInput.js';
import { JSDOM } from 'jsdom';
import { setARIAContainer } from '../../../../../base/browser/ui/aria/aria.js';
import { URI } from '../../../../../base/common/uri.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { Schemas } from '../../../../../base/common/network.js';
import { IClipboardService, type IClipboardResources } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IDialogService, type IConfirmationDialogOptions } from '../../../../../platform/dialogs/common/dialogs.js';
import { Event } from '../../../../../base/common/event.js';
import { IFileService, FileKind, FileNotFoundError, type IFileService as FileServiceContract } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { ISystemFileTransferService } from '../../../../../platform/files/common/systemFileTransferService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IQuickInputService, type IQuickInputService as QuickInputServiceContract } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IEditorService, type IEditorService as EditorServiceContract } from '../../../../services/editor/common/editorService.js';
import { TestWorkspaceService } from '../../../../services/configuration/test/common/testServices.js';
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

const configurations = new DisposableStore();
afterEach(() => configurations.clear());
suiteTeardown(() => configurations.dispose());

// URI paths use '/' on every host; URI.file() interprets filesystem separators for the current OS.
const fileCommandRoots = [
	{ name: 'POSIX', uri: 'file:///project' },
	{ name: 'Windows drive', uri: 'file:///C:/project' },
	{ name: 'UNC', uri: 'file://fileserver/share/project' },
] as const;

test('attachment side-open commands preserve explicit source and range without consulting Explorer selection', async () => {
	await import('../../browser/fileActions.contribution.js');
	using services = createFileActionServices();
	const calls: unknown[] = [];
	services.registerInstance(IExplorerService, { getContext: () => { assert.fail('Explicit attachment must not read Explorer selection'); } } as unknown as IExplorerService);
	services.registerInstance(IEditorService, { openEditor: async (input, options, target) => { calls.push({ input, options, target }); } } as EditorServiceContract);
	using commands = new CommandService(services);
	const resource = URI.parse('file:///project/captured.ts#3,2-5,6');
	await commands.executeCommand(OPEN_TO_SIDE_COMMAND_ID, resource);
	assert.deepEqual(calls, [{ input: { resource: URI.file('/project/captured.ts') }, options: { pinned: true, selection: new Range(3, 2, 5, 6) }, target: 'sideGroup' }]);
	await assert.rejects(commands.executeCommand(OPEN_TO_SIDE_COMMAND_ID, 'file:///project/invalid.ts'), /requires a resource URI/);
});

test('Explorer path and side-opening defaults match VS Code inside and outside editor focus', async () => {
	await import('../../browser/fileActions.contribution.js');
	using contexts = new ContextKeyService();
	const resolver = new KeybindingResolver();
	const label = (command: string) => getKeybindingLabel(resolver.lookupKeybinding(command, contexts)!, KeybindingLabelStyle.UserSettings);
	const path = isWindows ? 'shift+alt+c' : isMacintosh ? 'alt+cmd+c' : 'ctrl+alt+c';
	const relative = isMacintosh ? 'shift+alt+cmd+c' : isWindows ? 'ctrl+k ctrl+shift+c' : 'ctrl+shift+alt+c';
	assert.equal(label(COPY_PATH_COMMAND_ID), path);
	assert.equal(label(COPY_RELATIVE_PATH_COMMAND_ID), relative);
	assert.equal(label(OPEN_TO_SIDE_COMMAND_ID), 'ctrl+enter');
	contexts.setContext('editorFocus', true);
	assert.equal(label(COPY_PATH_COMMAND_ID), isWindows ? path : `${isMacintosh ? 'cmd' : 'ctrl'}+k ${path}`);
	assert.equal(label(COPY_RELATIVE_PATH_COMMAND_ID), isWindows ? relative : `${isMacintosh ? 'cmd' : 'ctrl'}+k ${relative}`);
});

test('Save File command saves the active editor', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
	Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.window.document });
	try {
		const { IEditorPart } = await import('../../../../browser/parts/editor/editorPart.js');
		await import('../../browser/fileActions.contribution.js');
		let saves = 0;
		const services = createFileActionServices();
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
		const services = createFileActionServices();
		services.registerInstance(IFileDialogService, {
			pickFolderAndOpen: async () => { throw new Error('Unexpected folder open'); },
			pickWorkspaceAndOpen: async () => { throw new Error('Unexpected workspace open'); },

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
			using workspace = new TestWorkspaceService({ id: 'project', uri: root });
			const services = createFileActionServices();
			using explorerService = createExplorerService(workspace);
			services.registerInstance(IWorkspaceContextService, workspace);
			services.registerInstance(IExplorerService, explorerService);
			services.registerInstance(IQuickInputService, {
				input: async options => {
					assert.equal(options.title, 'New File Name');
					assert.equal(await options.validateInput?.('../escape'), 'Enter a valid file name for the target file system.');
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
				refresh: async () => { },
				getContext: () => [new ExplorerItem(URI.parse(`${fileRoot.uri}/src`), 'src', FileKind.Directory)],
				getAccessibleContent: () => '',
				selectResource: async () => { },
				focus() { }, hasFocus: () => false,
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
	using workspace = new TestWorkspaceService({ id: 'project', uri: root });
	using explorer = createExplorerService(workspace);
	using registration = explorer.registerView({
		refresh: async () => { },
		getContext: () => [new ExplorerItem(folder, 'src', FileKind.Directory)],
		getAccessibleContent: () => '',
		selectResource: async () => { },
		focus() { }, hasFocus: () => false,
	});
	using services = createFileActionServices();
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IExplorerService, explorer);
	services.registerInstance(IEditorService, { activeEditor: undefined } as EditorServiceContract);
	services.registerInstance(IQuickInputService, {
		input: async options => {
			assert.equal(options.title, 'New Folder Name');
			assert.equal(await options.validateInput?.('../escape'), 'Enter a valid name for the target file system.');
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
	using workspace = new TestWorkspaceService({ id: 'project', uri: root });
	using explorer = createExplorerService(workspace);
	using registration = explorer.registerView({ refresh: async () => { }, getContext: () => selected, getAccessibleContent: () => '', selectResource: async () => { }, focus() { }, hasFocus: () => false });
	const existing = new Set(['/project/one.txt', '/project/two.txt', '/project/dest', '/project/dest/one.txt']);
	const copied: string[] = [];
	const renamed: string[] = [];
	let resourceClipboard: IClipboardResources = { resources: [], operation: 'copy' };
	using services = createFileActionServices();
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IExplorerService, explorer);
	services.registerInstance(IClipboardService, {
		readText: async () => '',
		triggerPaste: () => undefined,
		read: async () => [],
		readFindText: async () => '',
		writeFindText: async () => { },
		readImage: async () => new Uint8Array(),
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
		triggerPaste: () => undefined,
		read: async () => [],
		readFindText: async () => '',
		writeFindText: async () => { },
		readImage: async () => new Uint8Array(),
		writeText: async () => { },
		readResources: async () => clipboardResources,
		writeResources: async (resources: readonly URI[], operation: 'copy' | 'move') => { clipboardResources = { resources: [...resources], operation }; },
		hasResources: async () => clipboardResources.resources.length > 0,
	};
	using workspace = new TestWorkspaceService({ id: 'project', uri: root });
	using first = createExplorerService(workspace);
	using second = createExplorerService(workspace);
	using firstView = first.registerView({ refresh: async () => { }, getContext: () => [new ExplorerItem(source, '100% ready.bin', FileKind.File)], getAccessibleContent: () => '', selectResource: async () => { }, focus() { }, hasFocus: () => false });
	using secondView = second.registerView({ refresh: async () => { }, getContext: () => [new ExplorerItem(pasteDestination, 'destination', FileKind.Directory)], getAccessibleContent: () => '', selectResource: async () => { }, focus() { }, hasFocus: () => false });
	using firstServices = createFileActionServices();
	firstServices.registerInstance(IWorkspaceContextService, workspace);
	firstServices.registerInstance(IExplorerService, first);
	firstServices.registerInstance(IClipboardService, clipboard);
	using firstCommands = new CommandService(firstServices);
	await firstCommands.executeCommand(COPY_FILE_COMMAND_ID);

	const operations: string[] = [];
	using secondServices = createFileActionServices();
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
	using workspace = new TestWorkspaceService({
		id: 'project',
		folders: [
			{ id: 'outer', uri: URI.file('/project'), name: 'project', index: 0 },
			{ id: 'nested', uri: URI.file('/project/nested'), name: 'nested', index: 1 },
		],
	});
	using explorer = createExplorerService(workspace);
	using view = explorer.registerView({ refresh: async () => { }, getContext: () => [selected], getAccessibleContent: () => '', selectResource: async () => { }, focus() { }, hasFocus: () => false });
	let clipboardResources: IClipboardResources = { resources: [], operation: 'copy' };
	const operations: string[] = [];
	using services = createFileActionServices();
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IExplorerService, explorer);
	services.registerInstance(IClipboardService, {
		readText: async () => '',
		triggerPaste: () => undefined,
		read: async () => [],
		readFindText: async () => '',
		writeFindText: async () => { },
		readImage: async () => new Uint8Array(),
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
		using workspace = new TestWorkspaceService({ id: 'project', uri: URI.file('/project') });
		using explorer = createExplorerService(workspace);
		using view = explorer.registerView({ refresh: async () => { }, getContext: () => [new ExplorerItem(destination, 'destination', FileKind.Directory)], getAccessibleContent: () => '', selectResource: async () => { }, focus() { }, hasFocus: () => false });
		const pastes: { directory: string; moveRequested: boolean; }[] = [];
		using services = createFileActionServices();
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
		using workspace = new TestWorkspaceService({ id: 'project', uri: root });
		using explorer = createExplorerService(workspace);
		using view = explorer.registerView({ refresh: async () => { }, getContext: () => [new ExplorerItem(destination, 'destination', FileKind.Directory)], getAccessibleContent: () => '', selectResource: async () => { }, focus() { }, hasFocus: () => false });
		const writes: { resource: string; bytes: number[]; }[] = [];
		const attemptedTransfers: string[] = [];
		using services = createFileActionServices();
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
		using workspace = new TestWorkspaceService({ id: 'project', folders: [{ id: 'project', uri: root, name: 'project', index: 0 }] });
		const services = createFileActionServices();
		let activeEditor: IResourceEditorInput = { resource: file };
		services.registerInstance(IEditorService, {
			get activeEditor() { return activeEditor; },
		} as EditorServiceContract);
		services.registerInstance(IWorkspaceContextService, workspace);
		using explorer = createExplorerService(workspace);
		services.registerInstance(IExplorerService, explorer);
		services.registerInstance(IClipboardService, {
			readText: async () => copied.at(-1) ?? '',
			triggerPaste: () => undefined,
			read: async () => [],
			readFindText: async () => '',
			writeFindText: async () => { },
			readImage: async () => new Uint8Array(),
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
			const services = createFileActionServices();
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
	using workspace = new TestWorkspaceService({ id: 'project', uri: root });
	using explorer = createExplorerService(workspace);
	using registration = explorer.registerView({
		refresh: async () => { },
		getContext: () => [new ExplorerItem(selected, 'old.ts', FileKind.File)],
		getAccessibleContent: () => '',
		selectResource: async () => { },
		focus() { }, hasFocus: () => false,
	});
	using services = createFileActionServices();
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IExplorerService, explorer);
	services.registerInstance(IQuickInputService, {
		input: async options => {
			assert.equal(options.value, 'old.ts');
			assert.equal(await options.validateInput?.('../escape'), 'Enter a valid file name for the target file system.');
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

test('Explorer bulk commands retain multi-selection and deduplicate nested deletion targets', async () => {
	await import('../../browser/fileActions.contribution.js');
	const root = URI.file('/project');
	using workspace = new TestWorkspaceService({ id: 'project', uri: root });
	using explorer = createExplorerService(workspace);
	const selected = [
		new ExplorerItem(root, 'project', FileKind.Directory),
		new ExplorerItem(URI.file('/project/folder'), 'folder', FileKind.Directory),
		new ExplorerItem(URI.file('/project/folder/a.ts'), 'a.ts', FileKind.File),
		new ExplorerItem(URI.file('/project/b.ts'), 'b.ts', FileKind.File),
	];
	let focused = true;
	using view = explorer.registerView({ refresh: async () => { }, getContext: () => selected, hasFocus: () => focused, getAccessibleContent: () => '', selectResource: async () => { }, focus() { } });
	using services = createFileActionServices();
	services.registerInstance(IExplorerService, explorer);
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IEditorService, { activeEditor: { resource: URI.file('/project/active.ts') } } as EditorServiceContract);
	const copied: string[] = [];
	services.registerInstance(IClipboardService, { writeText: async value => { copied.push(value); } } as IClipboardService);
	const deleted: string[] = [];
	services.registerInstance(IFileService, { delete: async (resource: URI) => { deleted.push(resource.path); } } as unknown as FileServiceContract);
	let confirmed = false;
	services.registerInstance(IDialogService, {
		confirm: async options => {
			assert.equal(options.message, 'Permanently delete 2 selected items?');
			return { confirmed };
		}
	} as IDialogService);
	using commands = new CommandService(services);
	const separator = isWindows ? '\r\n' : '\n';
	await commands.executeCommand(COPY_PATH_COMMAND_ID);
	assert.equal(copied.at(-1), selected.map(item => item.resource.fsPath).join(separator));
	focused = false;
	await commands.executeCommand(COPY_PATH_COMMAND_ID, selected[1]!.resource, selected.slice(1).map(item => item.resource));
	assert.equal(copied.at(-1), selected.slice(1).map(item => item.resource.fsPath).join(separator));
	await commands.executeCommand(COPY_PATH_COMMAND_ID, URI.file('/project/active.ts'));
	assert.equal(copied.at(-1), URI.file('/project/active.ts').fsPath);
	await commands.executeCommand(COPY_PATH_COMMAND_ID);
	assert.equal(copied.at(-1), URI.file('/project/active.ts').fsPath);
	await commands.executeCommand(COPY_RELATIVE_PATH_COMMAND_ID, selected[1]!.resource, selected.slice(1).map(item => item.resource));
	assert.equal(copied.at(-1), ['folder', 'folder/a.ts', 'b.ts'].join(separator));
	await commands.executeCommand(DELETE_FILE_COMMAND_ID);
	assert.deepEqual(deleted, []);
	confirmed = true;
	await commands.executeCommand(DELETE_FILE_COMMAND_ID);
	assert.deepEqual(deleted, ['/project/folder', '/project/b.ts']);
});

test('Reveal in OS command sends the selected local file to the desktop host', async () => {
	const locations = [MenuId.ExplorerContext, MenuId.EditorTitleContext, MenuId.EditorTitle, MenuId.CommandPalette].filter(menu =>
		MenusRegistry.getMenuItems(menu).some(item => isMenuItem(item) && item.command.id === REVEAL_IN_OS_COMMAND_ID));
	assert.deepEqual(locations, [MenuId.ExplorerContext, MenuId.EditorTitleContext, MenuId.CommandPalette]);
	const root = URI.parse('file:///C:/project');
	const selected = URI.parse('file:///C:/project/src/main.ts');
	const other = URI.parse('file:///C:/project/other.ts');
	const revealed: string[] = [];
	using workspace = new TestWorkspaceService({ id: 'project', uri: root });
	using explorer = createExplorerService(workspace);
	using registration = explorer.registerView({
		refresh: async () => { },
		getContext: () => [new ExplorerItem(selected, 'main.ts', FileKind.File)],
		getAccessibleContent: () => '',
		selectResource: async () => { },
		focus() { }, hasFocus: () => false,
	});
	using services = createFileActionServices();
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
	const group = { id: 1, inputs: [active, clicked, second], selectedInputs: [active], editors: [active, clicked, second].map(input => ({ input })), activeInput: active };
	const copied: string[] = [];
	using workspace = new TestWorkspaceService({ id: 'project', uri: URI.file('/project') });
	using services = createFileActionServices();
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IEditorGroupsService, { getGroup: (id: number) => id === group.id ? group : undefined } as unknown as IEditorGroupsService);
	services.registerInstance(IEditorService, { activeEditor: active } as unknown as EditorServiceContract);
	services.registerInstance(IClipboardService, { writeText: async text => { copied.push(text); } } as IClipboardService);
	using commands = new CommandService(services);
	using context = new ContextKeyService();
	context.setContext(ResourceSchemeContext.key, clicked.resource.scheme);
	const menus = new MenuService(commands, context);
	const copyActions = (): readonly IAction[] => menus.getMenuActions(MenuId.EditorTitleContext, { arg: { groupId: group.id, editorIndex: 1 } }).find(([name]) => name === '2_files')![1].filter(action => action.id === COPY_PATH_COMMAND_ID || action.id === COPY_RELATIVE_PATH_COMMAND_ID);
	const actions = copyActions();
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
	assert.deepEqual(copyActions().map(action => ({ label: action.label, enabled: action.enabled })), [
		{ label: 'Copy Path', enabled: false },
		{ label: 'Copy Relative Path', enabled: false },
	]);
});

test('Reveal tab menu groups both destinations and targets the clicked inactive file', async () => {
	await import('../../browser/fileActions.contribution.js');
	await import('../../../../browser/parts/editor/editorCommands.js');
	await import('../../../../browser/parts/editor/editorActions.js');
	await import('../../../../browser/parts/editor/editor.contribution.js');
	const active = new FileEditorInput(URI.file('/project/active.ts'));
	const clicked = new FileEditorInput(URI.file('/project/src/clicked.ts'));
	const group = { id: 1, inputs: [active, clicked], selectedInputs: [active], editors: [{ input: active }, { input: clicked }], activeInput: active };
	const effects: unknown[] = [];
	using workspace = new TestWorkspaceService({ id: 'project', uri: URI.file('/project') });
	using explorer = createExplorerService(workspace);
	using view = explorer.registerView({
		refresh: async () => { },
		getContext: () => [new ExplorerItem(active.resource, active.label, FileKind.File)],
		getAccessibleContent: () => '',
		selectResource: async (resource, reveal) => { effects.push(['select', resource?.toString(), reveal]); },
		focus() { }, hasFocus: () => false,
	});
	using services = createFileActionServices();
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IExplorerService, explorer);
	services.registerInstance(IEditorService, { activeEditor: active } as unknown as EditorServiceContract);
	services.registerInstance(IEditorGroupsService, { getGroup: (id: number) => id === group.id ? group : undefined } as unknown as IEditorGroupsService);
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
	context.setContext(EditorsVisibleContext.key, true);
	context.setContext(ActiveEditorPinnedContext.key, false);
	context.setContext(ActiveEditorStickyContext.key, false);
	const menus = new MenuService(commands, context);
	const actions = menus.getMenuActions(MenuId.EditorTitleContext, { arg: { groupId: group.id, editorIndex: 1 } }).find(([name]) => name === '2_files')![1];
	assert.deepEqual(menus.getMenuActions(MenuId.EditorTitleContext).map(([name]) => name), ['1_close', '1_open', '2_files', '3_preview', '5_split', '7_new_window']);
	assert.deepEqual(actions.map(action => action.id), [COPY_PATH_COMMAND_ID, COPY_RELATIVE_PATH_COMMAND_ID, REVEAL_IN_EXPLORER_COMMAND_ID, REVEAL_IN_OS_COMMAND_ID]);
	for (const action of actions.filter(action => action.id === REVEAL_IN_EXPLORER_COMMAND_ID || action.id === REVEAL_IN_OS_COMMAND_ID)) await action.run();
	assert.deepEqual(effects, [['open', 'ash.explorer'], ['select', clicked.resource.toString(), 'force'], ['focus'], ['finder', clicked.resource.fsPath]]);
	context.setContext(MultipleEditorsSelectedInGroupContext.key, true);
	assert.deepEqual(menus.getMenuActions(MenuId.EditorTitleContext).find(([name]) => name === '2_files')![1].map(action => action.enabled), [true, true, false, false]);
	context.setContext(MultipleEditorsSelectedInGroupContext.key, false);
	context.setContext(ResourceSchemeContext.key, Schemas.untitled);
	assert.deepEqual(menus.getMenuActions(MenuId.EditorTitleContext).find(([name]) => name === '2_files')![1].map(action => ({ id: action.id, enabled: action.enabled })), [
		{ id: COPY_PATH_COMMAND_ID, enabled: false },
		{ id: COPY_RELATIVE_PATH_COMMAND_ID, enabled: false },
		{ id: REVEAL_IN_EXPLORER_COMMAND_ID, enabled: false },
	]);
});

for (const scenario of [
	{ label: 'Windows device alias', os: OperatingSystem.Windows, root: URI.parse('file:///C:/project'), name: 'CON.txt', valid: false },
	{ label: 'POSIX backslash', os: OperatingSystem.Linux, root: URI.parse('file:///project'), name: 'part\\name.txt', valid: true },
	{ label: 'SSH on a Windows client', os: OperatingSystem.Windows, root: createSshRemoteWorkspaceUri('build', '/project'), name: 'part\\name.txt', valid: true },
]) {
	for (const command of [NEW_FILE_COMMAND_ID, NEW_FOLDER_COMMAND_ID, RENAME_FILE_COMMAND_ID]) {
		test(`file name rules reach ${command}: ${scenario.label}`, async () => {
			await import('../../browser/fileActions.contribution.js');
			using workspace = new TestWorkspaceService({ id: 'test', uri: scenario.root });
			using explorer = createExplorerService(workspace);
			const original = scenario.root.joinPathSegment('original.txt');
			using view = explorer.registerView({
				refresh: async () => { },
				getContext: () => command === RENAME_FILE_COMMAND_ID ? [new ExplorerItem(original, 'original.txt', FileKind.File)] : [],
				getAccessibleContent: () => '', selectResource: async () => { }, focus() { }, hasFocus: () => false,
			});
			using services = createFileActionServices(scenario.os);
			services.registerInstance(IWorkspaceContextService, workspace);
			services.registerInstance(IExplorerService, explorer);
			services.registerInstance(IQuickInputService, {
				input: async options => {
					assert.equal(await options.validateInput?.(scenario.name) === undefined, scenario.valid);
					return scenario.name;
				},
			} as QuickInputServiceContract);
			const effects: string[] = [];
			services.registerInstance(IFileService, {
				createFile: async (resource: URI) => { effects.push(resource.path); return { resource, kind: FileKind.File, sizeBytes: 0, readonly: false, modifiedAtMillis: 0 }; },
				createDirectory: async (resource: URI) => { effects.push(resource.path); return { resource, kind: FileKind.Directory, sizeBytes: 0, readonly: false, modifiedAtMillis: 0 }; },
				rename: async (_source: URI, target: URI) => { effects.push(target.path); },
			} as unknown as FileServiceContract);
			services.registerInstance(IEditorService, { activeEditor: undefined, openEditor: async () => { } } as unknown as EditorServiceContract);
			using commands = new CommandService(services);
			if (scenario.valid) {
				await commands.executeCommand(command);
				assert.deepEqual(effects, [`/project/${scenario.name}`]);
			} else {
				await assert.rejects(commands.executeCommand(command), /valid .*name for the target file system/);
				assert.deepEqual(effects, []);
			}
		});
	}
	test(`paste applies destination file name rules: ${scenario.label}`, async () => {
		await import('../../browser/fileActions.contribution.js');
		using workspace = new TestWorkspaceService({ id: 'test', uri: scenario.root });
		using explorer = createExplorerService(workspace);
		const source = scenario.root.joinPathSegment(scenario.name);
		const destination = scenario.root.joinPathSegment('destination');
		using view = explorer.registerView({
			refresh: async () => { },
			getContext: () => [new ExplorerItem(destination, 'destination', FileKind.Directory)],
			getAccessibleContent: () => '', selectResource: async () => { }, focus() { }, hasFocus: () => false,
		});
		using services = createFileActionServices(scenario.os);
		services.registerInstance(IWorkspaceContextService, workspace);
		services.registerInstance(IExplorerService, explorer);
		services.registerInstance(IClipboardService, { readResources: async () => ({ resources: [source], operation: 'copy' }) } as unknown as IClipboardService);
		const copied: string[] = [];
		services.registerInstance(IFileService, {
			stat: async (resource: URI) => {
				if (resource.path !== source.path) throw new FileNotFoundError(resource);
				return { resource, kind: FileKind.File, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined };
			},
			copy: async (_source: URI, target: URI) => { copied.push(target.path); },
		} as unknown as FileServiceContract);
		using commands = new CommandService(services);
		await commands.executeCommand(PASTE_FILE_COMMAND_ID);
		assert.deepEqual(copied, scenario.valid ? [destination.joinPathSegment(scenario.name).path] : []);
	});
}

test('file name validation reports the target filesystem error in Chinese', async () => {
	await import('../../browser/fileActions.contribution.js');
	initializeTestLocalization('zh-CN');
	try {
		using workspace = new TestWorkspaceService({ id: 'test', uri: URI.parse('file:///C:/project') });
		using explorer = createExplorerService(workspace);
		using services = createFileActionServices(OperatingSystem.Windows);
		services.registerInstance(IWorkspaceContextService, workspace);
		services.registerInstance(IExplorerService, explorer);
		services.registerInstance(IEditorService, { activeEditor: undefined } as EditorServiceContract);
		services.registerInstance(IQuickInputService, {
			input: async options => {
				assert.equal(await options.validateInput?.('CON.txt'), '请输入目标文件系统允许的文件名。');
				return 'CON.txt';
			}
		} as QuickInputServiceContract);
		using commands = new CommandService(services);
		await assert.rejects(commands.executeCommand(NEW_FILE_COMMAND_ID), /请输入目标文件系统允许的文件名/);
	} finally {
		resetNlsResolver();
	}
});

test('Explorer paste keeps its original directory and stops after a workspace switch', async () => {
	await import('../../browser/fileActions.contribution.js');
	const root = URI.file('/project');
	using workspace = new TestWorkspaceService({ id: 'project', uri: root });
	using explorer = createExplorerService(workspace);
	const first = new ExplorerItem(root.joinPathSegment('first'), 'first', FileKind.Directory);
	const second = new ExplorerItem(root.joinPathSegment('second'), 'second', FileKind.Directory);
	const source = root.joinPathSegment('source.txt');
	let selection = [first];
	using view = explorer.registerView({ refresh: async () => { }, getContext: () => selection, hasFocus: () => false, getAccessibleContent: () => '', selectResource: async () => { }, focus() { } });
	using services = createFileActionServices();
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IExplorerService, explorer);
	let readStarted = new DeferredPromise<void>();
	let clipboardRead = new DeferredPromise<IClipboardResources>();
	services.registerInstance(IClipboardService, { readResources: () => { void readStarted.complete(); return clipboardRead.p; } } as IClipboardService);
	const targets: string[] = [];
	services.registerInstance(IFileService, {
		stat: async (resource: URI) => {
			if (resource.toString() !== source.toString()) throw new FileNotFoundError(resource);
			return { resource, kind: FileKind.File };
		},
		copy: async (_source: URI, target: URI) => { targets.push(target.path); },
	} as unknown as FileServiceContract);
	using commands = new CommandService(services);
	const pending = commands.executeCommand(PASTE_FILE_COMMAND_ID);
	await readStarted.p;
	selection = [second];
	await clipboardRead.complete({ resources: [source], operation: 'copy' });
	await pending;
	assert.deepEqual(targets, ['/project/first/source.txt']);

	selection = [first];
	readStarted = new DeferredPromise<void>();
	clipboardRead = new DeferredPromise<IClipboardResources>();
	const switched = commands.executeCommand(PASTE_FILE_COMMAND_ID);
	await readStarted.p;
	workspace.updateWorkspace({ id: 'other', uri: URI.file('/other') });
	selection = [];
	await clipboardRead.complete({ resources: [source], operation: 'copy' });
	await switched;
	assert.deepEqual(targets, ['/project/first/source.txt']);
});

test('Explorer read-only policy blocks rename and makes deletion override explicit in Chinese', async () => {
	await import('../../browser/fileActions.contribution.js');
	initializeTestLocalization('zh-CN');
	try {
		const root = URI.file('/project');
		const resource = root.joinPathSegment('locked.ts');
		using workspace = new TestWorkspaceService({ id: 'project', uri: root });
		using explorer = createExplorerService(workspace);
		using view = explorer.registerView({ refresh: async () => { }, getContext: () => [new ExplorerItem(resource, 'locked.ts', FileKind.File)], hasFocus: () => false, getAccessibleContent: () => '', selectResource: async () => { }, focus() { } });
		using services = createFileActionServices();
		services.registerInstance(IWorkspaceContextService, workspace);
		services.registerInstance(IExplorerService, explorer);
		const configuration = services.get(IConfigurationService);
		await configuration.updateValue('files.readonlyInclude', { '**/*.ts': true });
		assert.ok(services.get(IFilesConfigurationService).isReadonly(resource));
		let allowInput = false;
		services.registerInstance(IQuickInputService, {
			input: async () => {
				assert.ok(allowInput, 'Read-only rename must not prompt');
				await configuration.updateValue('files.readonlyInclude', { '**/*.ts': true });
				return 'renamed.ts';
			},
		} as unknown as QuickInputServiceContract);
		const deleted: string[] = [];
		services.registerInstance(IFileService, { delete: async (uri: URI) => { deleted.push(uri.path); } } as unknown as FileServiceContract);
		let confirmed = false;
		services.registerInstance(IDialogService, {
			confirm: async (options: IConfirmationDialogOptions) => {
				assert.equal(options.message, '永久删除 locked.ts？');
				assert.equal(options.detail, '选中的文件或文件夹已配置为只读。删除它们将覆盖只读保护。');
				return { confirmed };
			}
		} as IDialogService);
		using commands = new CommandService(services);
		await assert.rejects(commands.executeCommand(RENAME_FILE_COMMAND_ID), { message: '无法重命名 locked.ts，因为它已配置为只读。' });
		await configuration.updateValue('files.readonlyInclude', {});
		allowInput = true;
		await assert.rejects(commands.executeCommand(RENAME_FILE_COMMAND_ID), { message: '无法重命名 locked.ts，因为它已配置为只读。' });
		await commands.executeCommand(DELETE_FILE_COMMAND_ID);
		assert.deepEqual(deleted, []);
		confirmed = true;
		await commands.executeCommand(DELETE_FILE_COMMAND_ID);
		assert.deepEqual(deleted, ['/project/locked.ts']);
	} finally {
		resetNlsResolver();
	}
});

function createExplorerService(workspace: TestWorkspaceService): ExplorerService {
	return new ExplorerService(workspace, configurations.add(new FileService()), configurations.add(new InMemoryConfigurationService()));
}

function createFileActionServices(os: OperatingSystem = OperatingSystem.Linux): InstantiationService {
	const host = createDisconnectedRendererApi();
	const services = configurations.add(new InstantiationService(new ServiceCollection(...getSingletonServiceDescriptors())));
	services.registerInstance(IRendererHostService, { ...host, hasAppServer: true, appServer: { ...host.appServer, operatingSystem: os } });
	services.registerInstance(IConfigurationService, configurations.add(new InMemoryConfigurationService()));
	return services;
}

suite('fileMenus browser component', () => {
	const browserTests = useBrowserTests();
	teardown(async function () {
		const { page } = browserTests;
		await page.evaluate(() => window.ashFileMenusIntegration?.dispose());
	});

	test('Explorer keeps file scrolling inside its pane and uses themed scrolling for overflowing pane headers', async function () {
		const { page } = browserTests;
		const testInfo = browserTests.info;

		await page.goto('/fileMenus.html?paneLayout');
		await page.waitForFunction(() => !!window.ashFileMenusIntegration);
		const host = page.locator('#explorer');
		const panes = host.locator('.ash-pane-view-container');
		const tree = host.getByRole('tree');
		await expect(tree.getByRole('treeitem').first()).toBeVisible();
		const timeline = host.getByRole('button', { name: 'Timeline', exact: true });
		const before = await timeline.boundingBox();
		await tree.hover();
		await page.mouse.wheel(0, 500);
		const treeViewport = host.locator('.ash-list-scrollable > .ash-scrollbar-viewport');
		await expect.poll(() => treeViewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
		expect(await timeline.boundingBox()).toEqual(before);
		await expect(panes).toHaveCSS('overflow-y', 'hidden');
		await expect(panes.locator(':scope > .ash-scrollbar-track-vertical')).toBeHidden();
		await host.screenshot({ path: testInfo.outputPath('explorer-contained-scrollbar.png') });

		await page.evaluate(() => window.ashFileMenusIntegration.layoutPanes(80));
		const track = panes.locator(':scope > .ash-scrollbar-track-vertical');
		await panes.hover();
		await expect(track).toBeVisible();
		await expect(track).toHaveAttribute('aria-disabled', 'false');
		await track.focus();
		await track.press('End');
		await expect(timeline).toBeInViewport({ ratio: 1 });
		await timeline.focus();
		await expect(timeline).toBeFocused();
		await host.screenshot({ path: testInfo.outputPath('overflowing-pane-scrollbar.png') });
		await page.evaluate(() => window.ashFileMenusIntegration.layoutPanes(500));
		await expect(track).toBeHidden();
		await expect(timeline).toBeInViewport({ ratio: 1 });
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`Explorer keeps top-level folders lazy and truncates compact paths once (${locale})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`/fileMenus.html?locale=${locale}&compactFolders`);
			await page.waitForFunction(() => !!window.ashFileMenusIntegration);
			const rows = page.locator('#explorer .ash-tree-row');
			await expect(rows.locator('.ash-icon-label-text')).toHaveText(['examples', 'services', 'main.ts']);
			const rowGeometry = await rows.evaluateAll(elements => elements.map(element => ({
				height: element.getBoundingClientRect().height,
				top: element.getBoundingClientRect().top,
				lineHeight: getComputedStyle(element).lineHeight,
			})));
			expect(rowGeometry.map(row => [row.height, row.lineHeight])).toEqual([[22, '22px'], [22, '22px'], [22, '22px']]);
			expect(rowGeometry.slice(1).map((row, index) => row.top - rowGeometry[index]!.top)).toEqual([22, 22]);
			const iconActions = page.locator('#explorer .ash-toolbar .ash-action-view-item.icon > .ash-button');
			expect(await iconActions.count()).toBeGreaterThan(0);
			for (const action of await iconActions.all()) {
				await expect(action).toHaveCSS('width', '22px');
				await expect(action).toHaveCSS('height', '22px');
				expect(await action.boundingBox()).toMatchObject({ width: 22, height: 22 });
				await expect(action.locator('.ash-icon').first()).toHaveCSS('width', '16px');
				await expect(action.locator('.ash-icon').first()).toHaveCSS('height', '16px');
			}
			expect(await page.evaluate(() => window.ashFileMenusIntegration.directoryReads())).toEqual(['/workspace']);
			await rows.filter({ hasText: 'examples' }).click();
			await page.keyboard.press('ArrowRight');
			const compact = rows.filter({ hasText: 'examples/extensions/inspector-with-a-long-folder-name' });
			await expect(compact).toHaveCount(1);
			const label = compact.locator('.ash-icon-label-text');
			await expect(label.locator('.ash-icon-label-segment')).toHaveText(['examples', 'extensions', 'inspector-with-a-long-folder-name']);
			await page.locator('#explorer').evaluate(element => element.style.width = '240px');
			const geometry = await label.evaluate(element => {
				const style = getComputedStyle(element);
				return {
					display: style.display,
					overflow: style.overflowX,
					textOverflow: style.textOverflow,
					truncated: element.scrollWidth > element.clientWidth,
					segments: [...element.querySelectorAll('.ash-icon-label-segment')].map(segment => {
						const range = document.createRange();
						range.selectNodeContents(segment);
						return { box: segment.getBoundingClientRect().width, text: range.getBoundingClientRect().width };
					}),
				};
			});
			expect(geometry).toMatchObject({ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', truncated: true });
			for (const segment of geometry.segments) expect(Math.abs(segment.box - segment.text)).toBeLessThan(1);
			await label.hover();
			await expect(page.locator('.ash-hover')).toContainText('examples/extensions/inspector-with-a-long-folder-name');
			await page.mouse.move(700, 600);
			await page.keyboard.press('ArrowLeft');
			await expect(compact.locator('.ash-explorer-active-segment')).toHaveText('extensions');
			await page.keyboard.press('ArrowLeft');
			await expect(compact.locator('.ash-explorer-active-segment')).toHaveText('examples');
			await page.keyboard.press('ArrowRight');
			await expect(compact.locator('.ash-explorer-active-segment')).toHaveText('extensions');
			await page.screenshot({ path: testInfo.outputPath(`compact-folders-${locale}.png`) });
			await page.evaluate(() => window.ashFileMenusIntegration.setCompactFolders(false));
			await expect(rows.locator('.ash-icon-label-text.multiple')).toHaveCount(0);
			expect(errors).toEqual([]);
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`Explorer and editor title menus show scoped shortcuts (${locale})`, async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`/fileMenus.html?locale=${locale}`);
			expect(errors).toEqual([]);
			await page.waitForFunction(() => !!window.ashFileMenusIntegration);
			await page.locator('.ash-tree-row').filter({ hasText: 'main.ts' }).click({ button: 'right' });
			const labels = await page.evaluate(() => window.ashFileMenusIntegration.labels());
			for (const { title, chords } of labels) {
				const item = page.getByRole('menuitem', { name: title, exact: true });
				await expect(item).toBeVisible();
				await expect(item.locator('.ash-menu-keybinding kbd')).toHaveText(chords);
			}
			await page.keyboard.press('Escape');
			await expect(page.getByRole('menu')).toHaveCount(0);
			await expect(page.locator('.ash-tree')).toBeFocused();
			await page.locator('#editor-menu').click({ button: 'right' });
			for (const { title, chords } of labels.slice(4, 6)) {
				await expect(page.getByRole('menuitem', { name: title, exact: true }).locator('.ash-menu-keybinding kbd')).toHaveText(chords);
			}
			expect(errors).toEqual([]);
		});
	}

	test('Explorer default shortcuts copy paths and open to the side through the command service', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/fileMenus.html');
		expect(errors).toEqual([]);
		await page.waitForFunction(() => !!window.ashFileMenusIntegration);
		await page.locator('.ash-tree-row').filter({ hasText: 'main.ts' }).click({ button: 'right' });
		await page.keyboard.press('Escape');
		const bindings = await page.evaluate(() => window.ashFileMenusIntegration.bindings());
		const pressCommand = async (command: string) => {
			const keys: Record<string, string> = { cmd: 'Meta', ctrl: 'Control', shift: 'Shift', alt: 'Alt', enter: 'Enter' };
			for (const chord of bindings[command]!.split(' ')) {
				const shortcut = chord.split('+').map(key => keys[key] ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key)).join('+');
				await page.keyboard.press(shortcut);
			}
		};
		const expectedPath = await page.evaluate(() => navigator.userAgent.includes('Windows') ? '\\workspace\\main.ts' : '/workspace/main.ts');
		await pressCommand('copyFilePath');
		await expect.poll(() => page.evaluate(() => window.ashFileMenusIntegration.clipboard())).toEqual([expectedPath]);
		await pressCommand('copyRelativeFilePath');
		await expect.poll(() => page.evaluate(() => window.ashFileMenusIntegration.clipboard())).toEqual([expectedPath, 'main.ts']);
		await pressCommand('explorer.openToSide');
		await expect.poll(() => page.evaluate(() => window.ashFileMenusIntegration.opened())).toEqual([{ resource: 'file:///workspace/main.ts', target: 'sideGroup' }]);
	});

	suite('Windows file menu defaults', () => {
		browserTests.use({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36' });
		test('Explorer displays Windows path shortcuts including the relative-path chord', async function () {
			const { page } = browserTests;

			await page.goto('/fileMenus.html');
			await page.waitForFunction(() => !!window.ashFileMenusIntegration);
			expect(await page.evaluate(() => window.ashFileMenusIntegration.bindings())).toEqual({
				copyFilePath: 'shift+alt+c', copyRelativeFilePath: 'ctrl+k ctrl+shift+c', 'explorer.openToSide': 'ctrl+enter',
			});
			await page.locator('.ash-tree-row').filter({ hasText: 'main.ts' }).click({ button: 'right' });
			const item = page.getByRole('menuitem', { name: 'Copy Relative Path', exact: true });
			await expect(item.locator('.ash-menu-keybinding kbd')).toHaveText(['Ctrl+K', 'Ctrl+Shift+C']);
		});
	});

	test('application menu switches its root submenus on pointer entry', async function () {
		const { page } = browserTests;

		await page.goto('/fileMenus.html?applicationMenu');
		await page.waitForFunction(() => !!window.ashFileMenusIntegration);
		const trigger = page.getByRole('toolbar', { name: 'Title bar left actions' }).getByRole('button', { name: 'Application menu' });
		await expect(trigger).toHaveCount(1);
		await expect(trigger).toHaveAccessibleName('Application menu');
		await expect(trigger.locator('.ash-icon')).toBeVisible();
		await expect(trigger.locator('.ash-button-label')).toBeHidden();
		await expect(trigger).toHaveCSS('width', '22px');
		await expect(trigger).toHaveCSS('height', '22px');
		await expect(page.getByRole('toolbar', { name: 'Title bar left actions' }).getByRole('menubar')).toHaveCount(0);
		const adjacentAction = page.getByRole('button', { name: 'Toggle sidebar', exact: true });
		const [triggerBounds, actionBounds] = await Promise.all([trigger.boundingBox(), adjacentAction.boundingBox()]);
		expect(triggerBounds).not.toBeNull();
		expect(actionBounds).not.toBeNull();
		expect({ width: triggerBounds!.width, height: triggerBounds!.height }).toEqual({ width: actionBounds!.width, height: actionBounds!.height });
		await trigger.hover();
		await expect(trigger).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await trigger.click();
		const mainMenu = page.getByRole('menu').first();
		const fileMenuItem = mainMenu.getByRole('menuitem', { name: 'File' });
		const editMenuItem = mainMenu.getByRole('menuitem', { name: 'Edit' });

		await fileMenuItem.hover();
		await expect(fileMenuItem).toHaveAttribute('aria-expanded', 'true');
		await editMenuItem.hover();
		await expect(fileMenuItem).toHaveAttribute('aria-expanded', 'false');
		await expect(editMenuItem).toHaveAttribute('aria-expanded', 'true');
		const bounds = await editMenuItem.boundingBox();
		expect(bounds).not.toBeNull();
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await trigger.press('Enter');
		await expect(mainMenu).toBeFocused();
		await expect(editMenuItem).toHaveAttribute('aria-expanded', 'false');
		await expect(mainMenu.locator('.ash-action-view-item.focused')).toHaveCount(0);
		await page.mouse.move(bounds!.x + bounds!.width / 2 + 2, bounds!.y + bounds!.height / 2);
		await expect(editMenuItem).toHaveAttribute('aria-expanded', 'true');
	});

	test('application menu keeps submenu arrows inside their menu rows', async function () {
		const { page } = browserTests;

		await page.goto('/fileMenus.html?applicationMenu');
		await page.waitForFunction(() => !!window.ashFileMenusIntegration);
		await page.getByRole('button', { name: 'Application menu' }).click();
		const mainMenu = page.getByRole('menu').first();
		const fileItem = mainMenu.getByRole('menuitem', { name: 'File' });
		await fileItem.hover();
		await expect(fileItem).toHaveAttribute('aria-expanded', 'true');
		const arrow = fileItem.locator('.ash-submenu-indicator > .ash-icon');
		await expectIconFontLoaded(arrow);
		await expect(arrow).toHaveCSS('font-size', '12px');
		await expect(arrow.locator('svg')).toHaveCount(0);
		const [itemBounds, arrowBounds] = await Promise.all([fileItem.boundingBox(), arrow.boundingBox()]);
		expect(itemBounds).not.toBeNull();
		expect(arrowBounds).not.toBeNull();
		expect(arrowBounds!.width).toBe(12);
		expect(itemBounds!.x + itemBounds!.width - arrowBounds!.x - arrowBounds!.width).toBeGreaterThanOrEqual(8);
	});

	test('application menu aligns command labels with and without icons', async function () {
		const { page } = browserTests;

		await page.goto('/fileMenus.html?applicationMenu');
		await page.waitForFunction(() => !!window.ashFileMenusIntegration);
		await page.getByRole('button', { name: 'Application menu' }).click();
		const fileItem = page.getByRole('menu').first().getByRole('menuitem', { name: 'File' });
		await fileItem.hover();
		await expect(fileItem).toHaveAttribute('aria-expanded', 'true');
		const fileMenu = page.getByRole('menu').last();
		await expect(fileMenu.locator('..')).toHaveCSS('border-radius', '8px');
		const iconLabel = fileMenu.getByRole('menuitem', { name: 'With icon' }).locator('.ash-button-label');
		const plainLabel = fileMenu.getByRole('menuitem', { name: 'Without icon' }).locator('.ash-button-label');
		for (const [name, shortcut] of [['With icon', process.platform === 'darwin' ? '⌘N' : 'Ctrl+N'], ['Without icon', process.platform === 'darwin' ? '⌘A' : 'Ctrl+A']] as const) {
			const item = fileMenu.getByRole('menuitem', { name, exact: true });
			await expect(item.locator('.ash-button-label')).toHaveText(name);
			await expect(item.locator('.ash-menu-keybinding')).toHaveClass(/ash-keybinding-label-plain/u);
			const key = item.locator('.ash-menu-keybinding kbd');
			await expect(key).toHaveText(shortcut);
			const font = (element: Element) => ({ family: getComputedStyle(element).fontFamily, size: getComputedStyle(element).fontSize });
			expect(await key.evaluate(font)).toEqual(await item.evaluate(font));
		}
		const [iconBounds, plainBounds] = await Promise.all([iconLabel.boundingBox(), plainLabel.boundingBox()]);
		expect(iconBounds).not.toBeNull();
		expect(plainBounds).not.toBeNull();
		expect(Math.abs(iconBounds!.x - plainBounds!.x)).toBeLessThanOrEqual(1);
	});

	test('checked View menu icons stay inside the leading slot', async function () {
		const { page } = browserTests;

		await page.goto('/fileMenus.html?applicationMenu');
		await page.waitForFunction(() => !!window.ashFileMenusIntegration);
		await page.getByRole('button', { name: 'Application menu' }).click();
		const view = page.getByRole('menu').first().getByRole('menuitem', { name: 'File' });
		await view.hover();
		await expect(view).toHaveAttribute('aria-expanded', 'true');
		const viewMenu = page.getByRole('menu').last();
		for (const [actionId, checked, iconSelector] of [
			['fixture.checked', 'true', '.ash-menu-leading-check > .ash-icon'],
			['fixture.unchecked', 'false', '.ash-menu-leading-check > .ash-icon-label-icon > .ash-icon'],
		] as const) {
			const item = viewMenu.locator(`[data-action-id="${actionId}"] button`);
			await expect(item).toHaveAttribute('aria-checked', checked);
			const slot = item.locator('.ash-menu-leading-slot');
			const icon = item.locator(iconSelector);
			const label = item.locator('.ash-button-label');
			const [slotBounds, iconBounds, labelBounds] = await Promise.all([
				slot.boundingBox(), icon.boundingBox(), label.boundingBox(),
			]);
			expect(slotBounds).not.toBeNull();
			expect(iconBounds).not.toBeNull();
			expect(labelBounds).not.toBeNull();
			expect(iconBounds!.x).toBeGreaterThanOrEqual(slotBounds!.x);
			expect(iconBounds!.x + iconBounds!.width).toBeLessThanOrEqual(slotBounds!.x + slotBounds!.width);
			expect(labelBounds!.x).toBeGreaterThanOrEqual(iconBounds!.x + iconBounds!.width + 4);
		}
	});
});
