import { Schemas } from '../../../../../base/common/network.js';
import { BrowserWorkspaceEditingService } from '../../browser/workspaceEditingService.js';
import { BrowserHostService } from '../../../host/browser/browserHostService.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import type { HTMLFileSystemProvider } from '../../../../../platform/files/browser/htmlFileSystemProvider.js';
import type { INotificationService } from '../../../../../platform/notification/common/notification.js';
import type { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import type { IPathService } from '../../../../../platform/path/common/pathService.js';
import type { ILifecycleService } from '../../../lifecycle/common/lifecycle.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import '../../../../../editor/test/browser/testEditorDom.js';
import '../../../../contrib/files/browser/fileActions.contribution.js';
import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import { setARIAContainer } from '../../../../../base/browser/ui/aria/aria.js';
import { Event, Emitter } from '../../../../../base/common/event.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService, WorkbenchState, type IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import type { WorkspaceEditRequest } from '../../../../../platform/workspace/common/workspaceIpc.js';
import { IWorkspaceEditingService } from '../../common/workspaceEditing.js';
import { CommandService } from '../../../commands/common/commandService.js';
import { ADD_ROOT_FOLDER_COMMAND_ID, PICK_WORKSPACE_FOLDER_COMMAND_ID, SET_ROOT_FOLDER_COMMAND_ID } from '../../../../browser/actions/workspaceCommands.js';
import { REMOVE_ROOT_FOLDER_COMMAND_ID } from '../../../../contrib/files/browser/fileConstants.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import assert from 'node:assert/strict';
import { test, setup, teardown } from 'mocha';
import { AddRootFolderAction, RemoveRootFolderAction, SaveWorkspaceAsAction } from '../../../../browser/actions/workspaceActions.js';
import { initializeTestLocalization } from '../../../localization/test/common/localizationTestUtils.js';
import { WorkspaceEditingService } from '../../electron-browser/workspaceEditingService.js';
import { TestWorkspaceService } from '../../../configuration/test/common/testServices.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import type { IWorkingCopyService } from '../../../workingCopy/common/workingCopyService.js';
import type { IHostService } from '../../../host/browser/host.js';
import { resetNlsResolver } from '../../../../../nls.js';

let ariaRegion: import('../../../../../base/common/lifecycle.js').IDisposable;
setup(() => { ariaRegion = setARIAContainer(browserEnvironment.window.document.body); });
teardown(() => ariaRegion.dispose());
ensureNoDisposablesAreLeakedInTestSuite();

test('local workspace management uses the Chinese client translations', async () => {
	await initializeTestLocalization('zh-CN');
	try {
		const titles = [new AddRootFolderAction(), new RemoveRootFolderAction(), new SaveWorkspaceAsAction()].map(action => {
			const title = action.desc.title;
			return typeof title === 'string' ? title : title.value;
		});
		assert.deepEqual(titles, ['将文件夹添加到工作区...', '从工作区移除文件夹...', '将工作区另存为...']);
	} finally { resetNlsResolver(); }
});


test('folder validation keeps dirty files accessible until saved or reverted', async () => {
	const first = { id: 'one', name: 'one', uri: URI.file('/first'), index: 0 };
	const second = { id: 'two', name: 'two', uri: URI.file('/second'), index: 1 };
	using context = new TestWorkspaceService({ id: 'team', folders: [first, second], configuration: URI.file('/team.ash-workspace') });
	let dirty = true;
	const copies = { getAll: () => [{ resource: URI.file('/second/src/unsaved.ts'), isDirty: dirty }] } as unknown as IWorkingCopyService;
	using editing = new WorkspaceEditingService({ getWorkspace: async () => ({}), onDidChange: () => ({ dispose() { } }) }, context, {} as IFileDialogService, copies, {} as IHostService);
	assert.throws(() => editing.validateFolders([first.uri]), /Save or revert/);
	assert.doesNotThrow(() => editing.validateFolders([first.uri, second.uri]));
	assert.throws(() => editing.validateFolders([URI.file('/')]), /Save or revert/);
	assert.throws(() => editing.validateFolders([first.uri, second.uri, URI.file('/second/src')]), /Save or revert/);
	await initializeTestLocalization('zh-CN');
	try { assert.throws(() => editing.validateFolders([first.uri]), /请先保存或还原/); }
	finally { resetNlsResolver(); }
	dirty = false;
	assert.doesNotThrow(() => editing.validateFolders([first.uri]));
});

test('enterWorkspace waits for Desktop host acceptance and rejects a dirty current configuration', async () => {
	const current = URI.file('/team.ash-workspace');
	const target = URI.file('/other.code-workspace');
	using context = new TestWorkspaceService({ id: 'team', configuration: current, folders: [] });
	const accepted = new DeferredPromise<void>();
	const opened: unknown[] = [];
	let dirty = true;
	const copies = { get: () => dirty ? [{ resource: current, isDirty: true }] : [] } as unknown as IWorkingCopyService;
	const host = { openWindow: (...args: unknown[]) => { opened.push(args); return accepted.p; } } as unknown as IHostService;
	using editing = new WorkspaceEditingService({ getWorkspace: async () => ({}), onDidChange: Event.None }, context, {} as IFileDialogService, copies, host);
	await assert.rejects(editing.enterWorkspace(target), /Save or revert/);
	assert.deepEqual(opened, []);
	dirty = false;
	const pending = editing.enterWorkspace(target);
	assert.deepEqual(opened, [[[{ workspaceUri: target }], { forceReuseWindow: true }]]);
	assert.equal(context.getWorkspace().configuration, current);
	accepted.error(new Error('Workspace authorization denied'));
	await assert.rejects(pending, /Workspace authorization denied/);
	assert.equal(context.getWorkspace().configuration, current);
});

// Command tests use the actual desktop editing adapter. The fake host is the
// process boundary, so assertions observe the submitted operation and accepted state.
function commandServices(context: TestWorkspaceService, dialogs: Partial<IFileDialogService>, submitted: WorkspaceEditRequest[]) {
	const services = new InstantiationService();
	services.registerInstance(IWorkspaceContextService, context);
	services.registerInstance(IFileDialogService, dialogs as IFileDialogService);
	services.registerSingleton(IWorkspaceEditingService, () => new WorkspaceEditingService({
		getWorkspace: async () => ({}), onDidChange: Event.None,
		editWorkspace: async request => { submitted.push(request); return {}; },
	}, context, dialogs as IFileDialogService, { getAll: () => [], get: () => [] } as unknown as IWorkingCopyService, {} as IHostService));
	return services;
}

test('add-root action executes the shared command and submits one host edit', async () => {
	const root = { id: 'first', name: 'First', uri: URI.file('/first'), index: 0 };
	using context = new TestWorkspaceService({ id: 'first', folders: [root] });
	const submitted: WorkspaceEditRequest[] = [];
	using services = commandServices(context, { showOpenDialog: async () => [URI.file('/second')] }, submitted);
	using commands = new CommandService(services);
	services.registerInstance(ICommandService, commands);
	await new AddRootFolderAction().run(services);
	assert.deepEqual(submitted, [{ operation: 'folders', index: 1, deleteCount: 0, folders: [{ uri: URI.file('/second').toString() }] }]);
	assert.deepEqual(context.getWorkspace().folders, [root], 'renderer waits for the accepted host notification');
});

test('add-root command cancels without editing and ignores a dialog from an obsolete workspace', async () => {
	using context = new TestWorkspaceService({ id: 'empty', folders: [] });
	const submitted: WorkspaceEditRequest[] = [];
	const selection = new DeferredPromise<URI[] | undefined>();
	using services = commandServices(context, { showOpenDialog: () => selection.p }, submitted);
	using commands = new CommandService(services);
	const pending = commands.executeCommand(ADD_ROOT_FOLDER_COMMAND_ID);
	context.updateWorkspace({ id: 'another', folders: [] });
	selection.complete([URI.file('/second')]);
	await pending;
	assert.deepEqual(submitted, []);

});

for (const scheme of ['file', 'ash-remote']) test(`${scheme} workspace picker returns the chosen root and releases on cancel or workspace replacement`, async () => {
	const roots = ['one', 'two'].map((name, index) => ({ id: name, name, uri: URI.from({ scheme, authority: scheme === 'ash-remote' ? 'ssh+host' : '', path: `/${name}` }), index }));
	using context = new TestWorkspaceService({ id: 'team', folders: roots, configuration: URI.file('/team.ash-workspace') });
	using services = new InstantiationService();
	services.registerInstance(IWorkspaceContextService, context);
	using accepted = new Emitter<void>();
	using hidden = new Emitter<void>();
	let disposed = 0;
	const makePicker = () => ({ items: [] as readonly { label: string; description: string; folder: IWorkspaceFolder; }[], selectedItems: [] as readonly { folder: IWorkspaceFolder; }[], onDidAccept: accepted.event, onDidHide: hidden.event, show() { }, hide() { hidden.fire(); }, dispose() { disposed++; }, [Symbol.dispose]() { this.dispose(); } });
	let picker = makePicker();
	services.registerInstance(IQuickInputService, { createQuickPick: () => (picker = makePicker()) } as unknown as IQuickInputService);
	using commands = new CommandService(services);
	const chosen = commands.executeCommand(PICK_WORKSPACE_FOLDER_COMMAND_ID);
	assert.deepEqual(picker.items.map(item => item.folder), roots);
	assert.deepEqual(picker.items.map(item => item.description), roots.map(folder => scheme === 'file' ? folder.uri.fsPath : folder.uri.path));
	picker.selectedItems = [picker.items[1]!];
	accepted.fire();
	assert.deepEqual(await chosen, roots[1]);
	assert.equal(disposed, 1);
	picker.selectedItems = [];
	const cancelled = commands.executeCommand(PICK_WORKSPACE_FOLDER_COMMAND_ID);
	hidden.fire();
	assert.equal(await cancelled, undefined);
	using cancellation = new CancellationTokenSource();
	const aborted = commands.executeCommand(PICK_WORKSPACE_FOLDER_COMMAND_ID, [undefined, cancellation.token]);
	cancellation.cancel();
	assert.equal(await aborted, undefined);
	const replaced = commands.executeCommand(PICK_WORKSPACE_FOLDER_COMMAND_ID);
	context.updateWorkspace({ id: 'empty', folders: [] });
	assert.equal(await replaced, undefined);
	assert.equal(disposed, 4);
	await assert.rejects(commands.executeCommand(PICK_WORKSPACE_FOLDER_COMMAND_ID, { placeHolder: 'invalid' }), /arguments/);
});

test('Explorer remove command targets only selected roots and keeps the renderer unchanged until commit', async () => {
	const roots = ['one', 'two', 'three'].map((name, index) => ({ id: name, name, uri: URI.file(`/${name}`), index }));
	using context = new TestWorkspaceService({ id: 'team', folders: roots, configuration: URI.file('/team.ash-workspace') });
	const submitted: WorkspaceEditRequest[] = [];
	using services = commandServices(context, {}, submitted);
	using commands = new CommandService(services);
	await commands.executeCommand(REMOVE_ROOT_FOLDER_COMMAND_ID, roots[1]!.uri, [roots[1]!.uri, URI.file('/one/child')]);
	assert.deepEqual(submitted, [{ operation: 'folders', index: 0, deleteCount: 3, folders: [roots[0], roots[2]].map(folder => ({ uri: folder.uri.toString(), name: folder.name })) }]);
	await commands.executeCommand(REMOVE_ROOT_FOLDER_COMMAND_ID, URI.file('/two/child'));
	assert.equal(submitted.length, 1, 'nested directories never remove their containing root');
	await assert.rejects(commands.executeCommand(REMOVE_ROOT_FOLDER_COMMAND_ID, '/two'), /URI/);
	assert.deepEqual(context.getWorkspace().folders, roots);
});

test('WorkspaceService publishes granular events from one committed immutable context', () => {
	using context = new TestWorkspaceService({ id: 'empty', folders: [] });
	using listeners = new DisposableStore();
	const states: WorkbenchState[] = [];
	const deltas: { added: string[]; removed: string[]; changed: string[]; }[] = [];
	let names = 0;
	listeners.add(context.onDidChangeWorkbenchState(state => {
		assert.equal(context.getWorkbenchState(), state);
		states.push(state);
	}));
	listeners.add(context.onDidChangeWorkspaceFolders(event => {
		assert.ok(Object.isFrozen(context.getWorkspace()));
		for (const folder of [...event.added, ...event.changed]) assert.ok(context.getWorkspace().folders.includes(folder));
		deltas.push({ added: event.added.map(folder => folder.id), removed: event.removed.map(folder => folder.id), changed: event.changed.map(folder => folder.id) });
	}));
	listeners.add(context.onDidChangeWorkspaceName(() => { names++; }));
	const first = { id: 'one', uri: URI.file('/one'), name: 'One', index: 0 };
	const second = { id: 'two', uri: URI.file('/two'), name: 'Two', index: 1 };
	context.updateWorkspace({ id: 'one', folders: [first] });
	context.updateWorkspace({ id: 'team', name: 'Team', folders: [first, second], configuration: URI.file('/team.ash-workspace') });
	context.updateWorkspace({ ...context.getWorkspace(), folders: [{ ...second, index: 0 }, { ...first, index: 1 }] });
	context.updateWorkspace({ ...context.getWorkspace(), name: 'Renamed' });
	context.updateWorkspace(context.getWorkspace());
	assert.deepEqual(states, [WorkbenchState.FOLDER, WorkbenchState.WORKSPACE]);
	assert.deepEqual(deltas, [
		{ added: ['one'], removed: [], changed: [] },
		{ added: ['two'], removed: [], changed: [] },
		{ added: [], removed: [], changed: ['two', 'one'] },
	]);
	assert.equal(names, 3);
});

test('set-root command replaces the displayed roots through the same editing owner', async () => {
	using context = new TestWorkspaceService({ id: 'first', uri: URI.file('/first') });
	const submitted: WorkspaceEditRequest[] = [];
	using services = commandServices(context, { showOpenDialog: async () => [URI.file('/replacement')] }, submitted);
	using commands = new CommandService(services);
	await commands.executeCommand(SET_ROOT_FOLDER_COMMAND_ID);
	assert.deepEqual(submitted, [{ operation: 'folders', index: 0, deleteCount: 1, folders: [{ uri: URI.file('/replacement').toString() }] }]);
});

async function browserWorkspaceFixture() {
	const resources = new DisposableStore();
	const files = resources.add(new FileService());
	for (const scheme of ['file', Schemas.vscodeUserData]) {
		const provider = resources.add(new InMemoryFileSystemProvider());
		resources.add(files.registerProvider(scheme, provider));
	}
	const first = URI.file('/@browser/first/client');
	const second = URI.file('/@browser/second/server');
	await files.createDirectory(first);
	await files.createDirectory(second);
	const context = resources.add(new TestWorkspaceService({ id: first.toString(), uri: first }));
	const errors: string[] = [];
	const transitions: (boolean | undefined)[] = [];
	let reject = false;
	let dirty: URI | undefined;
	const host = resources.add(new BrowserHostService({
		workspaceProvider: {
			kind: 'local', provider: { openDirectory: async (uri: URI) => uri } as HTMLFileSystemProvider,
			updateWorkspace: async (next, preserveEditors) => {
				transitions.push(preserveEditors);
				if (reject) throw new Error('Host rejected the workspace');
				editing.validateFolders(next.folders.map(folder => folder.uri));
				context.updateWorkspace(next);
			},
		}
	}, {} as ILifecycleService, {} as IDialogService, {} as IPathService, files));
	const copies = { getAll: () => dirty ? [{ resource: dirty, isDirty: true }] : [], get: (uri: URI) => uri.toString() === dirty?.toString() ? [{ resource: dirty, isDirty: true }] : [] } as unknown as IWorkingCopyService;
	const editing = resources.add(new BrowserWorkspaceEditingService(context, {} as IFileDialogService, copies, host, files, { error: (error: string) => errors.push(error) } as unknown as INotificationService));
	return { resources, files, first, second, context, host, editing, errors, transitions, reject: () => { reject = true; }, setDirty: (uri: URI | undefined) => { dirty = uri; } };
}

test('enterWorkspace reads an existing Browser configuration without rewriting it', async () => {
	const fixture = await browserWorkspaceFixture();
	using resources = fixture.resources;
	const target = URI.joinPath(fixture.first, 'existing.code-workspace');
	const content = '// existing workspace\n' + JSON.stringify({ folders: [{ uri: fixture.second.toString(), name: 'Server' }], settings: { preserve: true } });
	const original = await fixture.files.writeFile({ resource: target, content }, { create: true, overwrite: false });
	await fixture.editing.enterWorkspace(target);
	const workspace = fixture.context.getWorkspace();
	assert.equal(workspace.configuration?.toString(), target.toString());
	assert.deepEqual(workspace.folders.map(folder => ({ uri: folder.uri.toString(), name: folder.name })), [{ uri: fixture.second.toString(), name: 'Server' }]);
	const stored = await fixture.files.readFile(target);
	assert.equal(stored.content, content);
	assert.equal(stored.revision, original.revision);
	assert.deepEqual(fixture.transitions, [undefined]);
});

test('Browser multi-root editing writes metadata, preserves JSONC on save and removes only the selected root', async () => {
	const fixture = await browserWorkspaceFixture();
	using resources = fixture.resources;
	await fixture.editing.addFolders([{ uri: fixture.second, name: 'Server' }]);
	const temporary = fixture.context.getWorkspace().configuration!;
	assert.equal(temporary.scheme, Schemas.vscodeUserData);
	assert.equal(fixture.context.getWorkspace().folders.length, 2);
	const source = (await fixture.files.readFile(temporary)).content;
	await fixture.files.writeFile({ resource: temporary, content: '// workspace comment\n' + source.replace('"folders"', '"settings": { "test": true }, "folders"') }, { create: false, overwrite: true });
	const target = URI.joinPath(fixture.first, 'team.code-workspace');
	await fixture.editing.saveAndEnterWorkspace(target);
	assert.deepEqual(fixture.transitions, [true, true]);
	const saved = (await fixture.files.readFile(target)).content;
	assert.ok(saved.includes('// workspace comment'));
	assert.deepEqual(JSON.parse(saved.slice(saved.indexOf('{'))).settings, { test: true });
	assert.deepEqual(fixture.context.getWorkspace().folders.map(folder => folder.uri.toString()), [fixture.first.toString(), fixture.second.toString()]);
	await fixture.editing.removeFolders([fixture.second]);
	assert.equal(fixture.context.getWorkspace().folders.length, 1);
	assert.equal((await fixture.files.stat(fixture.second)).kind, "directory");
	await fixture.host.openWindow([{ workspaceUri: target }]);
	assert.equal(fixture.context.getWorkspace().configuration?.toString(), target.toString());
});

test('Browser rejected workspace acceptance rolls back metadata without publishing a folder list', async () => {
	const fixture = await browserWorkspaceFixture();
	using resources = fixture.resources;
	await fixture.editing.addFolders([{ uri: fixture.second }]);
	const current = fixture.context.getWorkspace();
	const original = (await fixture.files.readFile(current.configuration!)).content;
	fixture.reject();
	await assert.rejects(fixture.editing.removeFolders([fixture.second]), /Host rejected/);
	assert.equal(fixture.context.getWorkspace(), current);
	assert.equal((await fixture.files.readFile(current.configuration!)).content, original);
});


async function waitForWorkspaceCondition(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!predicate()) {
		if (Date.now() > deadline) assert.fail('Workspace condition did not settle');
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

test('Browser external workspace edits use the same owner and retain accepted roots on invalid or dirty changes', async () => {
	const fixture = await browserWorkspaceFixture();
	using resources = fixture.resources;
	await fixture.editing.addFolders([{ uri: fixture.second }]);
	const resource = fixture.context.getWorkspace().configuration!;
	await fixture.files.writeFile({ resource, content: JSON.stringify({ folders: [{ uri: fixture.second.toString() }] }) }, { create: false, overwrite: true });
	await waitForWorkspaceCondition(() => fixture.context.getWorkspace().folders.length === 1);
	assert.equal(fixture.context.getWorkspace().folders[0]?.uri.toString(), fixture.second.toString());
	const accepted = fixture.context.getWorkspace();
	await fixture.files.writeFile({ resource, content: '{ invalid' }, { create: false, overwrite: true });
	await waitForWorkspaceCondition(() => fixture.errors.length === 1);
	assert.equal(fixture.context.getWorkspace(), accepted);
	fixture.setDirty(URI.joinPath(fixture.second, 'dirty.txt'));
	await fixture.files.writeFile({ resource, content: '{ "folders": [] }' }, { create: false, overwrite: true });
	await waitForWorkspaceCondition(() => fixture.errors.length === 2);
	assert.equal(fixture.context.getWorkspace(), accepted);
	fixture.setDirty(undefined);
	await fixture.files.writeFile({ resource, content: '{ "folders": [] }' }, { create: false, overwrite: true });
	await waitForWorkspaceCondition(() => fixture.context.getWorkspace().folders.length === 0);
});

test('Browser metadata operations reject dirty configuration and retain it without writing another file', async () => {
	const fixture = await browserWorkspaceFixture();
	using resources = fixture.resources;
	await fixture.editing.addFolders([{ uri: fixture.second }]);
	const current = fixture.context.getWorkspace();
	const previous = (await fixture.files.readFile(current.configuration!)).content;
	fixture.setDirty(current.configuration!);
	await assert.rejects(fixture.editing.saveAndEnterWorkspace(URI.joinPath(fixture.first, 'dirty.ash-workspace')), /Save or revert/);
	assert.equal(fixture.context.getWorkspace(), current);
	assert.equal((await fixture.files.readFile(current.configuration!)).content, previous);
});


test('Browser index edits cannot overwrite an external folder change awaiting its watcher', async () => {
	const fixture = await browserWorkspaceFixture();
	using resources = fixture.resources;
	await fixture.editing.addFolders([{ uri: fixture.second }]);
	const resource = fixture.context.getWorkspace().configuration!;
	const external = JSON.stringify({ folders: [{ uri: fixture.first.toString() }], settings: { external: true } });
	await fixture.files.writeFile({ resource, content: external }, { create: false, overwrite: true });
	await assert.rejects(fixture.editing.removeFolders([fixture.first]), /Workspace file changed during editing/);
	assert.equal((await fixture.files.readFile(resource)).content, external);
});


test('server enterWorkspace validates dirty folder ownership before publishing authenticated roots', async () => {
	using resources = new DisposableStore();
	const files = resources.add(new FileService());
	const provider = resources.add(new InMemoryFileSystemProvider());
	resources.add(files.registerProvider('file', provider));
	const first = URI.file('/server/first');
	const second = URI.file('/server/second');
	const target = URI.joinPath(first, 'team.ash-workspace');
	await files.createDirectory(first);
	await files.createDirectory(second);
	await files.writeFile({ resource: target, content: JSON.stringify({ folders: [{ path: '../second', name: 'Server' }] }) }, { create: true, overwrite: false });
	const context = resources.add(new TestWorkspaceService({ id: 'first', uri: first }));
	let published = 0;
	let dirty = true;
	let editing: BrowserWorkspaceEditingService;
	const host = resources.add(new BrowserHostService({
		workspaceProvider: {
			kind: 'server',
			client: {
				list: async () => { throw new Error('No directory picker expected'); },
				authorize: async () => { throw new Error('No folder navigation expected'); },
				updateWorkspace: async (configuration, folders) => {
					published++;
					assert.deepEqual(folders, [{ path: second.fsPath, name: 'Server' }]);
					return { workspace: { id: configuration.toString(), configuration, folders: [{ id: 'server-second', uri: second, name: 'Server', index: 0 }] }, complete: async (accepted: boolean) => { assert.equal(accepted, true); } };
				},
			},
			validateFolders: folders => editing.validateFolders(folders),
			prepareSwitch: async () => true,
			updateWorkspace: async workspace => { context.updateWorkspace(workspace); },
		}
	}, {} as ILifecycleService, {} as IDialogService, { getHostPath: async (resource: URI) => resource.fsPath } as IPathService, files));
	const copies = { getAll: () => dirty ? [{ resource: URI.joinPath(first, 'unsaved.ts'), isDirty: true }] : [], get: () => [] } as unknown as IWorkingCopyService;
	editing = resources.add(new BrowserWorkspaceEditingService(context, {} as IFileDialogService, copies, host, files, { error: () => undefined } as unknown as INotificationService));
	await assert.rejects(editing.enterWorkspace(target), /Save or revert/);
	assert.equal(published, 0);
	assert.equal(context.getWorkspace().id, 'first');
	dirty = false;
	await editing.enterWorkspace(target);
	assert.equal(published, 1);
	assert.equal(context.getWorkspace().configuration?.toString(), target.toString());
	assert.equal(context.getWorkspace().folders[0]?.id, 'server-second');
});

for (const failure of ['beforePublication', 'afterPublication', 'confirmation'] as const) {
	test(`server workspace ${failure} failure keeps UI, authorization outcome and metadata consistent`, async () => {
		const { WorkspaceTransitionCommittedError } = await import('../../common/workspaceEditing.js');
		using resources = new DisposableStore();
		const files = resources.add(new FileService());
		const provider = resources.add(new InMemoryFileSystemProvider());
		resources.add(files.registerProvider('file', provider));
		const first = URI.file('/server/first');
		const target = URI.joinPath(first, 'team.ash-workspace');
		await files.createDirectory(first);
		const context = resources.add(new TestWorkspaceService({ id: 'first', uri: first }));
		const outcomes: boolean[] = [];
		let editing: BrowserWorkspaceEditingService;
		const host = resources.add(new BrowserHostService({
			workspaceProvider: {
				kind: 'server',
				client: {
					list: async () => { throw new Error('No picker expected'); },
					authorize: async () => { throw new Error('No navigation expected'); },
					updateWorkspace: async configuration => ({
						workspace: { id: configuration.toString(), configuration, folders: [{ id: 'first', uri: first, name: 'first', index: 0 }] },
						complete: async accepted => { outcomes.push(accepted); if (failure === 'confirmation') throw new Error('Finish response lost'); },
					}),
				},
				validateFolders: folders => editing.validateFolders(folders),
				prepareSwitch: async () => true,
				updateWorkspace: async workspace => {
					if (failure === 'beforePublication') throw new Error('storage preparation failed');
					context.updateWorkspace(workspace);
					if (failure === 'afterPublication') throw new WorkspaceTransitionCommittedError('post-publication state restore failed', new Error('backup flush failed'));
				},
			}
		}, {} as ILifecycleService, {} as IDialogService, { getHostPath: async (resource: URI) => resource.fsPath } as IPathService, files));
		editing = resources.add(new BrowserWorkspaceEditingService(context, {} as IFileDialogService, { getAll: () => [], get: () => [] } as unknown as IWorkingCopyService, host, files, { error: () => undefined } as unknown as INotificationService));
		await assert.rejects(editing.saveAndEnterWorkspace(target));
		if (failure === 'beforePublication') {
			assert.deepEqual(outcomes, [false]);
			assert.equal(context.getWorkspace().configuration, undefined);
			await assert.rejects(files.readFile(target));
		} else {
			assert.deepEqual(outcomes, [true]);
			assert.equal(context.getWorkspace().configuration?.toString(), target.toString());
			assert.match((await files.readFile(target)).content, /folders/);
		}
	});
}

test('existing workspace configuration can be edited again after its containing directory becomes inaccessible', async () => {
	const fixture = await browserWorkspaceFixture();
	using resources = fixture.resources;
	const target = URI.joinPath(fixture.first, 'team.ash-workspace');
	await fixture.editing.saveAndEnterWorkspace(target);
	await fixture.editing.addFolders([{ uri: fixture.second }]);
	await fixture.editing.removeFolders([fixture.first]);
	const stat = fixture.files.stat.bind(fixture.files);
	fixture.files.stat = resource => {
		if (resource.toString() === fixture.first.toString()) throw new Error('Parent directory authorization denied');
		return stat(resource);
	};
	await fixture.editing.updateFolders(0, 1, [{ uri: fixture.second, name: 'Renamed Server' }]);
	await fixture.editing.saveAndEnterWorkspace(target);
	assert.deepEqual(fixture.context.getWorkspace().folders.map(folder => folder.uri.toString()), [fixture.second.toString()]);
	assert.match((await fixture.files.readFile(target)).content, /server/);
});
