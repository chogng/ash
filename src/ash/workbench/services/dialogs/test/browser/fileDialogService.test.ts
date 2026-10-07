import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ConfirmResult, DialogResult, DialogSeverity, type IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import type { HTMLFileSystemProvider } from '../../../../../platform/files/browser/htmlFileSystemProvider.js';
import { FileKind, FileNotFoundError, type IFileService } from '../../../../../platform/files/common/files.js';
import type { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { FileDialogService } from '../../browser/fileDialogService.js';
import { DialogService } from '../../common/dialogService.js';
import type { IWebWorkspaceClient } from '../../../workspaces/browser/workspaceOpenService.js';

test('file dialog service owns the save, discard, and cancel decision', async () => {
	using dialogs = new DialogService();
	const service = new FileDialogService({
		kind: 'server', client: {} as IWebWorkspaceClient,
		quickInput: () => { throw new Error('No picker expected'); },
		fileService: () => { throw new Error('No file service expected'); },
		workspaceRoot: () => undefined,
	}, () => dialogs);
	const result = service.showSaveConfirm([URI.file('/work/draft.md')], 'The file changed on disk.');
	const item = dialogs.model.dialogs[0];
	assert.deepEqual(item?.request, {
		kind: 'choice', severity: DialogSeverity.Warning, title: 'Save Changes',
		message: 'Do you want to save the changes you made to draft.md?',
		detail: "Your changes will be lost if you don't save them.\nThe file changed on disk.",
		checkbox: undefined, buttons: ['Save', "Don't Save"], cancelButton: 'Cancel',
	});
	item?.close({ button: DialogResult.Primary, buttonIndex: 1 });
	assert.equal(await result, ConfirmResult.DONT_SAVE);
	const cancelled = service.showSaveConfirm(['draft.md']);
	dialogs.model.dialogs[0]?.cancel();
	assert.equal(await cancelled, ConfirmResult.CANCEL);
	assert.equal(await service.showSaveConfirm([]), ConfirmResult.DONT_SAVE);
});

test('file dialog service lists multiple unsaved files and offers Save All', async () => {
	using dialogs = new DialogService();
	const service = new FileDialogService({
		kind: 'server', client: {} as IWebWorkspaceClient,
		quickInput: () => { throw new Error('No picker expected'); },
		fileService: () => { throw new Error('No file service expected'); },
		workspaceRoot: () => undefined,
	}, () => dialogs);
	const result = service.showSaveConfirm(['one.md', URI.file('/work/two.md')]);
	const request = dialogs.model.dialogs[0]?.request;
	assert.equal(request?.message, 'Do you want to save the changes to the following 2 files?');
	assert.equal(request?.detail, "one.md\ntwo.md\nYour changes will be lost if you don't save them.");
	assert.deepEqual(request?.kind === 'choice' ? request.buttons : undefined, ['Save All', "Don't Save"]);
	dialogs.model.dialogs[0]?.close({ button: DialogResult.Primary, buttonIndex: 0 });
	assert.equal(await result, ConfirmResult.SAVE);
});

test('browser folder selection registers the chosen directory once', async () => {
	const handle = { name: 'notes' } as FileSystemDirectoryHandle;
	const registered: FileSystemDirectoryHandle[] = [];
	const provider = {
		async registerDirectoryHandle(value: FileSystemDirectoryHandle) {
			registered.push(value);
			return URI.file('/@browser/notes');
		},
	} as HTMLFileSystemProvider;
	const service = new FileDialogService({
		kind: 'local', provider, pickDirectory: async () => handle,
		quickInput: () => { throw new Error('No file picker expected'); },
		fileService: () => { throw new Error('No file service expected'); },
		workspaceRoot: () => undefined,
	}, () => { throw new Error('No message dialog expected'); });

	assert.deepEqual(await service.showOpenDialog({ canSelectFiles: false, canSelectFolders: true }), [URI.file('/@browser/notes')]);
	assert.deepEqual(registered, [handle]);
});

test('browser folder picker starts in the requested authorized directory', async () => {
	const startIn = { name: 'notes' } as FileSystemDirectoryHandle;
	let received: FileSystemDirectoryHandle | undefined;
	const provider = {
		getDirectoryHandle: async (resource: URI) => {
			assert.deepEqual(resource, URI.file('/@browser/session/notes'));
			return startIn;
		},
		registerDirectoryHandle: async () => URI.file('/@browser/selected'),
	} as unknown as HTMLFileSystemProvider;
	const service = new FileDialogService({
		kind: 'local', provider,
		pickDirectory: async initial => { received = initial; return startIn; },
		quickInput: () => { throw new Error('No Quick Pick expected'); },
		fileService: () => { throw new Error('No file service expected'); },
		workspaceRoot: () => undefined,
	}, () => { throw new Error('No message expected'); });
	assert.deepEqual(await service.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, defaultUri: URI.file('/@browser/session/notes') }), [URI.file('/@browser/selected')]);
	assert.equal(received, startIn);
});

test('browser Save As selects a directory and reads the file name from a dialog', async () => {
	const inputs: string[] = [];
	const provider = {
		async registerDirectoryHandle() { return URI.file('/@browser/notes'); },
	} as unknown as HTMLFileSystemProvider;
	const dialogs = {
		async input(options: { readonly inputs: readonly { readonly value?: string; }[]; }) {
			inputs.push(options.inputs[0]?.value ?? '');
			return { confirmed: true, values: ['draft with spaces.txt'] };
		},
	} as unknown as IDialogService;
	const service = new FileDialogService({
		kind: 'local', provider, pickDirectory: async () => ({ name: 'notes' }) as FileSystemDirectoryHandle,
		quickInput: () => { throw new Error('No file picker expected'); },
		fileService: () => ({ stat: async (resource: URI) => { throw new FileNotFoundError(resource); } }) as unknown as IFileService,
		workspaceRoot: () => undefined,
	}, () => dialogs);

	assert.deepEqual(await service.pickFileToSave(URI.file('/Untitled-1')), URI.file('/@browser/notes/draft with spaces.txt'));
	assert.deepEqual(inputs, ['Untitled-1']);
});

test('browser Save As requires confirmation before replacing an existing file', async () => {
	let confirmed = false;
	const existing = URI.file('/@browser/notes/report.txt');
	const dialogs = {
		input: async () => ({ confirmed: true, values: ['report.txt'] }),
		confirm: async () => ({ confirmed }),
	} as unknown as IDialogService;
	const service = new FileDialogService({
		kind: 'local',
		provider: { registerDirectoryHandle: async () => URI.file('/@browser/notes') } as unknown as HTMLFileSystemProvider,
		pickDirectory: async () => ({ name: 'notes' }) as FileSystemDirectoryHandle,
		quickInput: () => { throw new Error('No file picker expected'); },
		fileService: () => ({ stat: async () => ({ kind: FileKind.File }) }) as unknown as IFileService,
		workspaceRoot: () => undefined,
	}, () => dialogs);

	assert.equal(await service.pickFileToSave(URI.file('/report.txt')), undefined);
	confirmed = true;
	assert.deepEqual(await service.pickFileToSave(URI.file('/report.txt')), existing);
});

test('server folder selection navigates directories before returning the chosen path', async () => {
	const listed: string[] = [];
	const client = {
		async list(path: string) {
			listed.push(path);
			return path === ''
				? { path: '/work', parent: null, directories: [{ name: 'notes', path: '/work/notes' }] }
				: { path: '/work/notes', parent: '/work', directories: [] };
		},
		async authorize() { throw new Error('Authorization is owned by workspace opening'); },
	} as IWebWorkspaceClient;
	let pickerCount = 0;
	const quickInput = {
		createQuickPick() {
			const accepted = new Emitter<IQuickPickItem>();
			const hidden = new Emitter<void>();
			const index = pickerCount++;
			return {
				items: [] as IQuickPickItem[],
				onDidAccept: accepted.event,
				onDidHide: hidden.event,
				show() { accepted.fire(this.items[index === 0 ? 1 : 0]!); },
				dispose() { accepted.dispose(); hidden.dispose(); },
				[Symbol.dispose]() { accepted.dispose(); hidden.dispose(); },
			};
		},
	} as unknown as IQuickInputService;
	const service = new FileDialogService({
		kind: 'server', client, quickInput: () => quickInput, workspaceRoot: () => URI.file('/work'),
		fileService: () => { throw new Error('No file service expected'); },
	}, () => { throw new Error('No message dialog expected'); });

	assert.deepEqual(await service.showOpenDialog({ canSelectFiles: false, canSelectFolders: true }), [URI.file('/work/notes')]);
	assert.deepEqual(listed, ['', '/work/notes']);
});

test('browser Open File browses the current workspace and returns the chosen file', async () => {
	const root = URI.file('/work');
	const notes = URI.file('/work/notes');
	const paper = URI.file('/work/notes/paper.md');
	const listed: URI[] = [];
	const files = {
		async readDirectory(resource: URI) {
			listed.push(resource);
			return resource.toString() === root.toString()
				? [{ resource: notes, name: 'notes', kind: FileKind.Directory }]
				: [{ resource: paper, name: 'paper.md', kind: FileKind.File }];
		},
	} as unknown as IFileService;
	const quickInput = {
		createQuickPick() {
			const accepted = new Emitter<IQuickPickItem>();
			const hidden = new Emitter<void>();
			const triggered = new Emitter<{ item: IQuickPickItem; button: { id: string; label: string; }; }>();
			return {
				items: [] as IQuickPickItem[],
				onDidAccept: accepted.event,
				onDidHide: hidden.event,
				onDidTriggerItemButton: triggered.event,
				show() { accepted.fire(this.items.find(item => item.label !== '..')!); },
				dispose() { accepted.dispose(); hidden.dispose(); triggered.dispose(); },
				[Symbol.dispose]() { accepted.dispose(); hidden.dispose(); triggered.dispose(); },
			};
		},
	} as unknown as IQuickInputService;
	const service = new FileDialogService({
		kind: 'server',
		client: {} as IWebWorkspaceClient,
		quickInput: () => quickInput,
		fileService: () => files,
		workspaceRoot: () => root,
	}, () => { throw new Error('No message dialog expected'); });

	assert.deepEqual(await service.showOpenDialog({ canSelectFiles: true, canSelectFolders: false }), [paper]);
	assert.deepEqual(listed, [root, notes]);
});

test('browser file dialog filters files and returns every selected file from the default folder', async () => {
	const root = URI.file('/work');
	const folder = URI.file('/work/docs');
	const first = URI.file('/work/docs/first.md');
	const second = URI.file('/work/docs/second.MD');
	const shown: string[][] = [];
	let step = 0;
	const quickInput = {
		createQuickPick() {
			const accepted = new Emitter<IQuickPickItem>();
			const hidden = new Emitter<void>();
			const triggered = new Emitter<{ item: IQuickPickItem; button: { id: string; label: string; }; }>();
			return {
				items: [] as IQuickPickItem[],
				onDidAccept: accepted.event,
				onDidHide: hidden.event,
				onDidTriggerItemButton: triggered.event,
				show() {
					shown.push(this.items.map(item => item.label));
					accepted.fire(this.items[[0, 1, 3, 0][step++]!]!);
				},
				dispose() { accepted.dispose(); hidden.dispose(); triggered.dispose(); },
				[Symbol.dispose]() { accepted.dispose(); hidden.dispose(); triggered.dispose(); },
			};
		},
	} as unknown as IQuickInputService;
	const files = {
		stat: async () => ({ kind: FileKind.Directory }),
		readDirectory: async () => [
			{ resource: first, name: 'first.md', kind: FileKind.File },
			{ resource: second, name: 'second.MD', kind: FileKind.File },
			{ resource: URI.file('/work/docs/skip.txt'), name: 'skip.txt', kind: FileKind.File },
		],
	} as unknown as IFileService;
	const service = new FileDialogService({ kind: 'server', client: {} as IWebWorkspaceClient, quickInput: () => quickInput, fileService: () => files, workspaceRoot: () => root }, () => { throw new Error('No message expected'); });
	const result = await service.showOpenDialog({
		canSelectFiles: true, canSelectFolders: false, canSelectMany: true, defaultUri: folder,
		filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Text', extensions: ['txt'] }],
	});
	assert.deepEqual(result, [first, second]);
	assert.deepEqual(shown[0], ['Markdown', 'Text']);
	assert.ok(shown[1]?.includes('Select first.md'));
	assert.ok(!shown.flat().includes('skip.txt'));
	assert.ok(shown[3]?.[0]?.startsWith('Done (2)'));
});

test('server folder dialog selects folders across directory navigation', async () => {
	const shown: string[][] = [];
	let step = 0;
	const quickInput = {
		createQuickPick() {
			const accepted = new Emitter<IQuickPickItem>();
			const hidden = new Emitter<void>();
			const triggered = new Emitter<{ item: IQuickPickItem; button: { id: string; label: string; }; }>();
			return {
				items: [] as IQuickPickItem[], onDidAccept: accepted.event, onDidHide: hidden.event, onDidTriggerItemButton: triggered.event,
				show() {
					shown.push(this.items.map(item => item.label));
					const label = ['Select /work', 'other', 'Select /work/other', 'Done (2)'][step++];
					accepted.fire(this.items.find(item => item.label === label)!);
				},
				dispose() { accepted.dispose(); hidden.dispose(); triggered.dispose(); },
				[Symbol.dispose]() { accepted.dispose(); hidden.dispose(); triggered.dispose(); },
			};
		},
	} as unknown as IQuickInputService;
	const client = {
		list: async (path: string) => path === '' || path === '/work'
			? { path: '/work', parent: null, directories: [{ path: '/work/other', name: 'other' }] }
			: { path: '/work/other', parent: '/work', directories: [] }, authorize: async () => { throw new Error('Not needed'); }
	} as IWebWorkspaceClient;
	const service = new FileDialogService({ kind: 'server', client, quickInput: () => quickInput, fileService: () => { throw new Error('No file service expected'); }, workspaceRoot: () => undefined }, () => { throw new Error('No message expected'); });
	assert.deepEqual(await service.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: true }), [URI.file('/work'), URI.file('/work/other')]);
	assert.ok(shown[3]?.includes('Done (2)'));
});

test('browser Save As applies the chosen filter and custom dialog labels', async () => {
	const messages: string[] = [];
	let inputs = 0;
	const dialogs = {
		input: async (options: { title?: string; primaryButton?: string; }) => {
			assert.equal(options.title, 'Export');
			assert.equal(options.primaryButton, 'Write');
			return { confirmed: true, values: [inputs++ === 0 ? 'report.txt' : 'report.md'] };
		},
		showMessage: async (options: { message: string; }) => { messages.push(options.message); },
	} as unknown as IDialogService;
	const service = new FileDialogService({
		kind: 'server', client: {} as IWebWorkspaceClient,
		quickInput: () => { throw new Error('No filter picker expected'); },
		fileService: () => ({ stat: async (resource: URI) => { throw new FileNotFoundError(resource); } }) as unknown as IFileService,
		workspaceRoot: () => URI.file('/work'),
	}, () => dialogs);
	assert.deepEqual(await service.showSaveDialog({ title: 'Export', saveLabel: 'Write', defaultUri: URI.file('/work/report.md'), filters: [{ name: 'Markdown', extensions: ['md'] }] }), URI.file('/work/report.md'));
	assert.equal(inputs, 2);
	assert.equal(messages.length, 1);
	await assert.rejects(service.showOpenDialog({ canSelectFiles: true, availableFileSystems: ['other'] }), /file scheme only/);
});

test('browser document open chooses an authorized folder without replacing the workspace', async () => {
	const root = URI.file('/@browser/chosen');
	const paper = root.joinPathSegment('design.ash-design.json');
	const handle = { name: 'chosen' } as FileSystemDirectoryHandle;
	const provider = {
		registerDirectoryHandle: async () => root,
		getDirectoryHandle: async (resource: URI) => { assert.deepEqual(resource, root); return handle; },
	} as unknown as HTMLFileSystemProvider;
	const files = {
		stat: async (resource: URI) => ({ resource, kind: resource.toString() === paper.toString() ? FileKind.File : FileKind.Directory }),
		readDirectory: async () => [{ resource: paper, name: 'design.ash-design.json', kind: FileKind.File }],
	} as unknown as IFileService;
	const quickInput = {
		createQuickPick() {
			const accepted = new Emitter<IQuickPickItem>();
			const hidden = new Emitter<void>();
			const triggered = new Emitter<{ item: IQuickPickItem; button: { id: string; label: string; }; }>();
			return {
				items: [] as IQuickPickItem[], onDidAccept: accepted.event, onDidHide: hidden.event, onDidTriggerItemButton: triggered.event,
				show() { accepted.fire(this.items[0]); },
				dispose() { accepted.dispose(); hidden.dispose(); triggered.dispose(); },
				[Symbol.dispose]() { accepted.dispose(); hidden.dispose(); triggered.dispose(); },
			};
		},
	} as unknown as IQuickInputService;
	const service = new FileDialogService({ kind: 'local', provider, pickDirectory: async () => handle, quickInput: () => quickInput, fileService: () => files, workspaceRoot: () => undefined }, () => { throw new Error('Unexpected message'); });
	assert.deepEqual(await service.showOpenDialog({ canSelectFiles: true, filters: [{ name: 'Ash design', extensions: ['ash-design.json'] }] }), [paper]);
	assert.deepEqual(await service.showOpenDialog({ canSelectFiles: true, defaultUri: paper, filters: [{ name: 'Ash design', extensions: ['json'] }] }), [paper]);
});
