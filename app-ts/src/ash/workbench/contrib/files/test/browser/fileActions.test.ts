import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { URI } from '../../../../../base/common/uri.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { Event } from '../../../../../base/common/event.js';
import { IFileService, FileKind, type IFileService as FileServiceContract } from '../../../../../platform/files/common/files.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, type IQuickInputService as QuickInputServiceContract } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IEditorService, type IEditorService as EditorServiceContract } from '../../../../services/editor/common/editorService.js';
import { WorkspaceContextService } from '../../../../services/workspaces/browser/workspaceContextService.js';
import type { IEditorPart as EditorPartContract } from '../../../../browser/parts/editor/editorPart.js';
import { COPY_PATH_COMMAND_ID, COPY_RELATIVE_PATH_COMMAND_ID, OPEN_FILE_COMMAND_ID, SAVE_FILE_COMMAND_ID } from '../../browser/fileConstants.js';
import { DOWNLOAD_COMMAND_ID, NEW_FILE_COMMAND_ID } from '../../browser/fileActions.js';
import { IExplorerService } from '../../browser/files.js';
import { ExplorerService } from '../../browser/explorerService.js';
import { ExplorerItem } from '../../common/explorerModel.js';
import { INativeHostService } from '../../../../common/services.js';
import type { INativeHostApi } from '../../../../../platform/native/common/nativeHost.js';
import { REVEAL_IN_OS_COMMAND_ID } from '../../electron-browser/fileActions.contribution.js';
import { NATIVE_HOST_REVEAL_FILE_CHANNEL } from '../../../../../platform/native/common/nativeHost.js';
import { nativeHostIpcRoutes, type INativeHostMainService } from '../../../../../platform/native/electron-main/nativeHostIpc.js';

test('Save File command saves the active editor', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
	Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.window.document });
	try {
		const { IEditorPart } = await import('../../../../browser/parts/editor/editorPart.js');
		await import('../../browser/fileActions.contribution.js');
		let saves = 0;
		const services = new ServiceContainer();
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
		const services = new ServiceContainer();
		services.registerInstance(IFileDialogService, {
			pickFileToSave: async () => { throw new Error('Unexpected Save As'); },
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

test('New File command creates and opens a file in the active workspace folder', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
	Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.window.document });
	try {
		await import('../../browser/fileActions.contribution.js');
		const root = URI.file('C:\\project');
		const created: URI[] = [];
		const opened: URI[] = [];
		using workspace = new WorkspaceContextService({ id: 'project', uri: root });
		const services = new ServiceContainer();
		const explorerService = new ExplorerService();
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

		assert.deepEqual(created.map(resource => resource.fsPath), ['C:\\project\\new %中.txt']);
		assert.deepEqual(opened.map(resource => resource.toString()), created.map(resource => resource.toString()));

		using viewRegistration = explorerService.registerView({
			getContext: () => [new ExplorerItem(URI.file('C:\\project\\src'), 'src', FileKind.Directory)],
			getAccessibleContent: () => '',
			focus() {},
		});
		await commands.executeCommand(NEW_FILE_COMMAND_ID);
		assert.equal(created.at(-1)?.fsPath, 'C:\\project\\src\\new %中.txt');
	} finally {
		if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
		else Reflect.deleteProperty(globalThis, 'document');
		browser.window.close();
	}
});

test('Copy Path commands copy the active file and its workspace-relative path', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
	Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.window.document });
	try {
		await import('../../browser/fileActions.contribution.js');
		const root = URI.file('C:\\project');
		const file = URI.file('C:\\project\\src\\main.ts');
		const copied: string[] = [];
		using workspace = new WorkspaceContextService({ id: 'project', folders: [{ id: 'project', uri: root, name: 'project', index: 0 }] });
		const services = new ServiceContainer();
		services.registerInstance(IEditorService, {
			activeEditor: { resource: file },
		} as EditorServiceContract);
		services.registerInstance(IWorkspaceContextService, workspace);
		services.registerInstance(IClipboardService, {
			readText: async () => copied.at(-1) ?? '',
			writeText: async (value: string) => { copied.push(value); },
		});
		using commands = new CommandService(services);

		await commands.executeCommand(COPY_PATH_COMMAND_ID);
		await commands.executeCommand(COPY_RELATIVE_PATH_COMMAND_ID);

		assert.deepEqual(copied, ['C:\\project\\src\\main.ts', 'src/main.ts']);
		await assert.rejects(commands.executeCommand(COPY_RELATIVE_PATH_COMMAND_ID, URI.file('C:\\outside\\other.ts')), /outside the current workspace/);
		assert.equal(copied.length, 2);
	} finally {
		if (previousDocument) {
			Object.defineProperty(globalThis, 'document', previousDocument);
		} else {
			Reflect.deleteProperty(globalThis, 'document');
		}
		browser.window.close();
	}
});

test('Download File command preserves the active file bytes and filename', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
	Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.window.document });
	try {
		await import('../../browser/fileActions.contribution.js');
		const resource = URI.file('C:\\project\\payload.bin');
		const reads: URI[] = [];
		let downloadedName: string | undefined;
		let downloadedBlob: Blob | undefined;
		browser.window.URL.createObjectURL = (blob: Blob) => {
			downloadedBlob = blob;
			return 'blob:ash-download';
		};
		browser.window.URL.revokeObjectURL = () => {};
		browser.window.HTMLAnchorElement.prototype.click = function () {
			downloadedName = this.download;
		};
		const services = new ServiceContainer();
		services.registerInstance(IEditorService, { activeEditor: { resource } } as EditorServiceContract);
		services.registerInstance(IFileService, {
			readFileBytes: async requested => {
				reads.push(requested);
				return { resource: requested, bytes: new Uint8Array([0, 255, 42]), revision: 'r1' };
			},
		} as FileServiceContract);
		using commands = new CommandService(services);

		await commands.executeCommand(DOWNLOAD_COMMAND_ID);

		assert.equal(downloadedName, 'payload.bin');
		assert.deepEqual(reads, [resource]);
		assert.deepEqual([...new Uint8Array(await downloadedBlob!.arrayBuffer())], [0, 255, 42]);
	} finally {
		if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
		else Reflect.deleteProperty(globalThis, 'document');
		browser.window.close();
	}
});

test('Reveal in OS command sends the selected local file to the desktop host', async () => {
	const root = URI.file('C:\\project');
	const selected = URI.file('C:\\project\\src\\main.ts');
	const revealed: string[] = [];
	using workspace = new WorkspaceContextService({ id: 'project', uri: root });
	const explorer = new ExplorerService();
	using registration = explorer.registerView({
		getContext: () => [new ExplorerItem(selected, 'main.ts', FileKind.File)],
		getAccessibleContent: () => '',
		focus() {},
	});
	using services = new ServiceContainer();
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IExplorerService, explorer);
	services.registerInstance(IEditorService, { activeEditor: undefined } as EditorServiceContract);
	services.registerInstance(INativeHostService, {
		revealFile: async path => { revealed.push(path); },
	} as INativeHostApi);
	using commands = new CommandService(services);

	await commands.executeCommand(REVEAL_IN_OS_COMMAND_ID);
	assert.deepEqual(revealed, [selected.fsPath]);
	await commands.executeCommand(REVEAL_IN_OS_COMMAND_ID, URI.file('C:\\project\\other.ts'));
	assert.deepEqual(revealed, [selected.fsPath, 'C:\\project\\other.ts']);
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
