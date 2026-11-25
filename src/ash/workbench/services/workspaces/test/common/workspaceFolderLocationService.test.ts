import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ILocalGitService } from '../../../../../platform/git/common/localGitService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceFolderLocationService, type IFolderLocation, type IFolderLocationChangeEvent } from '../../../../../platform/workspace/common/folderLocations.js';
import { IWorkspaceContextService, workspaceFromIdentifier } from '../../../../../platform/workspace/common/workspace.js';
import type { IWorkspaceContextApi, WorkspaceEditRequest } from '../../../../../platform/workspace/common/workspaceIpc.js';
import { IDialogService, IFileDialogService, type IConfirmationDialogOptions } from '../../../../../platform/dialogs/common/dialogs.js';
import { SwitchFolderLocationAction } from '../../../../browser/actions/workspaceActions.js';
import { IDebugService, type IDebugSession } from '../../../../contrib/debug/common/debug.js';
import { CommandService } from '../../../commands/common/commandService.js';
import { TestWorkspaceService } from '../../../configuration/test/common/testServices.js';
import { IHostService } from '../../../host/browser/host.js';
import { IWorkingCopyService } from '../../../workingCopy/common/workingCopyService.js';
import { WorkspaceFolderLocationService } from '../../common/workspaceFolderLocationService.js';
import { IWorkspaceEditingService } from '../../common/workspaceEditing.js';
import { WorkspaceEditingService } from '../../electron-browser/workspaceEditingService.js';

type FolderLocationItem = IQuickPickItem & IFolderLocation;

class TestFolderLocationPicker extends Disposable {
	private readonly acceptEmitter = this._register(new Emitter<void>());
	private readonly hideEmitter = this._register(new Emitter<void>());
	private readonly itemsEmitter = this._register(new Emitter<readonly FolderLocationItem[]>());
	readonly onDidAccept = this.acceptEmitter.event;
	readonly onDidHide = this.hideEmitter.event;
	private rows: readonly FolderLocationItem[] = [];
	title = '';
	activeItems: readonly FolderLocationItem[] = [];
	selectedItems: readonly FolderLocationItem[] = [];
	get items(): readonly FolderLocationItem[] { return this.rows; }
	set items(value: readonly FolderLocationItem[]) {
		this.rows = value;
		this.activeItems = value.slice(0, 1);
		this.itemsEmitter.fire(value);
	}
	nextItems(): Promise<readonly FolderLocationItem[]> {
		return new Promise(resolve => Event.once(this.itemsEmitter.event)(resolve));
	}
	show(): void { }
	hide(): void { this.hideEmitter.fire(); }
	accept(): void {
		this.selectedItems = this.activeItems;
		this.acceptEmitter.fire();
	}
}

test('Desktop folder location command switches from the primary location and back through the host', async () => {
	setNlsMessages('zh-CN', JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/workbench-files.json', 'utf8')));
	using localization = toDisposable(resetNlsResolver);
	const primary = URI.file('/project');
	const checkout = URI.file('/review');
	const original = workspaceFromIdentifier({ id: 'project', uri: primary });
	using context = new TestWorkspaceService(original);
	using services = new InstantiationService();
	services.registerInstance(IWorkspaceContextService, context);
	services.registerInstance(ILogService, new NullLoggerService());
	const git: Pick<ILocalGitService, 'listWorktrees'> = {
		listWorktrees: async (_token, sourcePath) => {
			assert.equal(sourcePath, primary.fsPath);
			return [
				{ label: 'main', path: primary.fsPath, sourcePath },
				{ label: 'review', path: checkout.fsPath, sourcePath },
			];
		},
	};
	services.registerInstance(ILocalGitService, git as ILocalGitService);
	services.registerInstance(IFileDialogService, {} as IFileDialogService);
	const confirmations: IConfirmationDialogOptions[] = [];
	services.registerInstance(IDialogService, {
		confirm: async (options: IConfirmationDialogOptions) => {
			confirmations.push(options);
			return { confirmed: true };
		},
	} as IDialogService);
	let debugStopped = false;
	services.registerInstance(IDebugService, {
		sessions: [{ id: 'debug' } as IDebugSession],
		stopAll: async () => { debugStopped = true; },
	} as unknown as IDebugService);
	services.registerInstance(IHostService, {} as IHostService);
	let dirty = true;
	services.registerInstance(IWorkingCopyService, {
		getAll: () => [{ resource: URI.joinPath(primary, 'unsaved.ts'), isDirty: dirty }],
	} as unknown as IWorkingCopyService);
	services.registerSingleton(IWorkspaceFolderLocationService, () => services.createInstance(WorkspaceFolderLocationService));
	services.registerInstance(IContextKeyService, { getValue: () => undefined } as unknown as IContextKeyService);
	using picker = new TestFolderLocationPicker();
	services.registerInstance(IQuickInputService, { createQuickPick: () => picker } as unknown as IQuickInputService);

	const submitted: WorkspaceEditRequest[] = [];
	const locations = services.get(IWorkspaceFolderLocationService);
	const changes: IFolderLocationChangeEvent[] = [];
	using listener = locations.onDidChangeLocation(event => changes.push(event));
	const host: IWorkspaceContextApi = {
		getWorkspace: async () => ({}),
		onDidChange: Event.None,
		editWorkspace: async request => {
			submitted.push(request);
			assert.equal(request.operation, 'folderLocation');
			if (request.reason === 'user') assert.equal(debugStopped, true);
			context.updateWorkspace({
				...original,
				folders: [{ ...original.folders[0]!, uri: URI.parse(request.target) }],
				folderLocation: { primary, reason: request.reason, ...(request.alternate && { alternate: request.alternate }) },
			});
		},
	};
	using editing = services.createInstance(WorkspaceEditingService, host);
	services.registerInstance(IWorkspaceEditingService, editing);
	using registration = registerAction2(SwitchFolderLocationAction);
	using commands = new CommandService(services);

	const first = original.folders[0]!;
	assert.deepEqual((await locations.getFolderLocations(first, CancellationToken.None)).map(entry => entry.uri.toString()), [primary.toString(), checkout.toString()]);
	assert.equal((await locations.getLocationGroups(primary, CancellationToken.None))[0]?.label, 'Git 工作树');
	await assert.rejects(editing.setFolderLocation(checkout), /请先保存或还原/);
	await assert.rejects(editing.setFolderLocation(URI.file('/unknown')), /所选文件夹位置已不可用/);
	assert.deepEqual(submitted, []);
	dirty = false;
	const command = commands.executeCommand('workbench.action.switchFolderLocation');
	assert.deepEqual(picker.activeItems.map(item => item.uri), [primary]);
	const items = await picker.nextItems();
	assert.equal(picker.title, '切换文件夹位置');
	assert.deepEqual(items.map(item => [item.label, item.picked]), [['project', true], ['review', false]]);
	picker.activeItems = [items[1]!];
	picker.accept();
	await command;
	const active = context.getWorkspace().folders[0]!;
	assert.equal(context.getWorkspace().id, original.id);
	assert.equal(locations.getLocation(active)?.providerId, 'git-worktrees');
	assert.deepEqual(changes, [{ folder: active, reason: 'user' }]);
	await editing.setFolderLocation(primary, { folder: active.uri });
	assert.equal(submitted.length, 2);
	assert.equal(locations.isAtAlternateLocation(context.getWorkspace().folders[0]!), false);
	assert.equal(changes[1]?.reason, 'programmatic');
	assert.deepEqual(confirmations, [{
		title: '切换文件夹位置',
		message: '要将文件夹位置切换到“review”吗？',
		detail: '切换会停止此窗口中正在运行的任务和调试会话。',
		primaryButton: '停止并切换',
		destructive: true,
	}]);
});

test('Desktop folder location command preserves a focused URI across provider updates', async () => {
	const primary = URI.file('/project');
	const first = { uri: URI.file('/first/review'), label: 'review' };
	const second = { uri: URI.file('/second/review'), label: 'review' };
	using context = new TestWorkspaceService({ id: 'project', uri: primary });
	using services = new InstantiationService();
	using picker = new TestFolderLocationPicker();
	services.registerInstance(IWorkspaceContextService, context);
	services.registerInstance(ILogService, new NullLoggerService());
	services.registerInstance(ILocalGitService, { listWorktrees: async () => [] } as unknown as ILocalGitService);
	services.registerInstance(IContextKeyService, { getValue: () => undefined } as unknown as IContextKeyService);
	services.registerInstance(IQuickInputService, { createQuickPick: () => picker } as unknown as IQuickInputService);
	const submitted: URI[] = [];
	services.registerInstance(IWorkspaceEditingService, { setFolderLocation: async (uri: URI) => { submitted.push(uri); } } as IWorkspaceEditingService);
	using locations = services.createInstance(WorkspaceFolderLocationService);
	services.registerInstance(IWorkspaceFolderLocationService, locations);
	using registration = registerAction2(SwitchFolderLocationAction);
	using commands = new CommandService(services);
	using changes = new Emitter<void>();
	const superseded = new DeferredPromise<IFolderLocation[]>();
	let response = Promise.resolve([first, second]);
	let latestToken: CancellationToken | undefined;
	using provider = locations.registerProvider({
		id: 'review',
		onDidChangeLocations: changes.event,
		provideLocations: (_primary, token) => {
			latestToken = token;
			return response;
		},
		resolveLocation: async () => undefined,
	});

	const command = commands.executeCommand('workbench.action.switchFolderLocation');
	const initial = await picker.nextItems();
	picker.activeItems = [initial[2]!];
	response = superseded.p;
	changes.fire();
	const supersededToken = latestToken;
	response = Promise.resolve([second, first]);
	changes.fire();
	const updated = await picker.nextItems();
	assert.deepEqual(updated.map(item => item.uri), [primary, second.uri, first.uri]);
	assert.equal(picker.activeItems[0], updated[1]);
	assert.equal(supersededToken?.isCancellationRequested, true);
	await superseded.complete([first]);
	picker.accept();
	await command;
	assert.deepEqual(submitted, [second.uri]);
});

test('provider removal and cancellation discard in-flight folder location results', async () => {
	const primary = URI.file('/project');
	const checkout = { uri: URI.file('/review'), label: 'review' };
	using context = new TestWorkspaceService({ id: 'project', uri: primary });
	using services = new InstantiationService();
	services.registerInstance(IWorkspaceContextService, context);
	services.registerInstance(ILogService, new NullLoggerService());
	services.registerInstance(ILocalGitService, { listWorktrees: async () => [] } as unknown as ILocalGitService);
	using locations = services.createInstance(WorkspaceFolderLocationService);
	using changes = new Emitter<void>();
	const pending = new DeferredPromise<typeof checkout[]>();
	let updates = 0;
	using listener = locations.onDidChangeLocations(() => updates++);
	const provider = locations.registerProvider({
		id: 'review',
		onDidChangeLocations: changes.event,
		provideLocations: () => pending.p,
		resolveLocation: async () => checkout,
	});
	changes.fire();
	assert.equal(updates, 1);
	const removed = locations.getLocations(primary, CancellationToken.None);
	using cancellation = new CancellationTokenSource();
	const canceled = locations.getLocations(primary, cancellation.token);
	cancellation.cancel();
	await assert.rejects(canceled, { name: 'CancellationError' });
	provider.dispose();
	changes.fire();
	pending.complete([checkout]);
	assert.deepEqual(await removed, []);
	assert.equal(updates, 1);
});
