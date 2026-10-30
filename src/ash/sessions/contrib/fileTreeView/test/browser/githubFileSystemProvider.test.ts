import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { setARIAContainer } from '../../../../../base/browser/ui/aria/aria.js';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationTokenSource, type CancellationToken } from '../../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAccountService, type AccountState } from '../../../../../platform/accounts/common/accountService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IWorkingCopyService } from '../../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { IChatWidgetService, type IChatWidget } from '../../../../../workbench/contrib/chat/browser/chat.js';
import { ChatAttachmentModel } from '../../../../../workbench/contrib/chat/browser/attachments/chatAttachmentModel.js';
import { ChatAttachmentResolveService, IChatAttachmentResolveService } from '../../../../../workbench/contrib/chat/browser/attachments/chatAttachmentResolveService.js';
import type { ChatContextAttachment } from '../../../../../workbench/services/chat/common/chatContextService.js';
import type { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem, type IQuickPickItemButton } from '../../../../../platform/quickinput/common/quickInput.js';
import { quickInputServiceTestControls } from '../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../workbench/services/notification/test/common/testNotificationService.js';
import { TestEditorService } from '../../../../../workbench/contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { FileKind, FileOperationNotSupportedError, FileSystemProviderErrorCode, IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { createDisconnectedGitHubService } from '../../../../../platform/github/browser/appServerGitHubService.js';
import { GitHubRepositoryEntryKind, IGitHubService, type GitHubAccount, type GitHubRepositoryTree } from '../../../../../platform/github/common/githubService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { BrowserFileSearchService } from '../../../../../platform/search/browser/browserFileSearchService.js';
import { IFileSearchService } from '../../../../../platform/search/common/fileSearch.js';
import { IContentSearchService } from '../../../../../platform/search/common/search.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { BulkEditTestServices } from '../../../../../workbench/contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import { TestWorkspaceService } from '../../../../../workbench/services/configuration/test/common/testServices.js';
import { QueryType, ISearchService } from '../../../../../workbench/services/search/common/search.js';
import { SearchService } from '../../../../../workbench/services/search/common/searchService.js';
import { IFileTextModelService } from '../../../../../workbench/services/textmodelResolver/common/textModelResourceService.js';
import { localize, resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import translatedGitHub from '../../../../../../../extensions/language-pack-zh-cn/translations/github.json' with { type: 'json' };
import { GITHUB_REMOTE_FILE_SCHEME } from '../../../../services/sessions/common/session.js';
import '../../browser/fileTreeView.contribution.js';

const root = URI.from({ scheme: GITHUB_REMOTE_FILE_SCHEME, authority: 'github', path: '/team/repo/feature%2Ffiles' });
const file = URI.joinPath(root, 'src/main.ts');
const sha = 'a'.repeat(40);
const tree: GitHubRepositoryTree = {
	sha, entries: [
		{ path: 'src/main.ts', kind: GitHubRepositoryEntryKind.File, sha, size: 4 },
		{ path: 'src/main.test.ts', kind: GitHubRepositoryEntryKind.File, sha, size: 4 },
		{ path: 'README.md', kind: GitHubRepositoryEntryKind.File, sha, size: 4 },
		{ path: 'node_modules/hidden.ts', kind: GitHubRepositoryEntryKind.File, sha, size: 4 },
	]
};

class RepositoryFixture extends Disposable {
	public readonly services = this._register(new InstantiationService());
	public readonly files = this._register(new FileService());
	public readonly accountChanges = this._register(new Emitter<AccountState>());
	public accounts: readonly GitHubAccount[] = [{ id: 'account', host: 'github.com', login: 'person', status: 'ready', credentialRevision: 1n }];
	public readonly treeRequests: { reference: string; token: CancellationToken | undefined; }[] = [];
	public readonly blobRequests: string[] = [];
	public currentWidget: IChatWidget | undefined;
	public readBlob: () => Promise<Uint8Array> = async () => this.bytes;
	public readonly configuration: BulkEditTestServices['configuration'];
	public readonly notifications = this._register(new TestNotificationService());
	public loadTree: () => Promise<GitHubRepositoryTree> = async () => tree;
	public bytes = new Uint8Array([239, 187, 191, 65]);
	public readonly search: SearchService;
	public readonly host: ReturnType<typeof WorkbenchContributionsRegistry.createHost>;

	constructor() {
		super();
		this.services.registerInstance(IFileService, this.files);
		this.services.registerInstance(IGitHubService, {
			...createDisconnectedGitHubService(),
			listAccounts: async () => this.accounts,
			readRepositoryTree: async (repository, reference, token) => { assert.equal(repository.accountId, this.accounts[0]?.id); this.treeRequests.push({ reference, token }); return this.loadTree(); },
			readRepositoryBlob: async (_repository, sha) => { this.blobRequests.push(sha); return { sha, bytes: await this.readBlob() }; },
		});
		this.services.registerInstance(IAccountService, {
			onDidChangeAccounts: this.accountChanges.event, onDidCompleteLogin: Event.None,
			read: async () => ({ revision: 1n, accounts: [] }),
			startLogin: async () => { throw new Error('Reads must not prompt for authorization'); },
			cancelLogin: async () => { throw new Error('Unexpected login cancellation'); },
			logout: async () => { throw new Error('Reads must not change accounts'); },
		});
		const models = this._register(new BulkEditTestServices([]));
		this.configuration = models.configuration;
		this.services.registerInstance(IConfigurationService, models.configuration);
		this.services.registerInstance(IWorkingCopyService, models.workingCopies);
		const fixture = this;
		this.services.registerInstance(IChatWidgetService, {
			onDidChangeWidgets: Event.None,
			get lastFocusedWidget() { return fixture.currentWidget; },
			getAllWidgets: () => this.currentWidget ? [this.currentWidget] : [],
			register: () => { throw new Error('Unexpected widget registration'); },
		});
		const workspace = this._register(new TestWorkspaceService({ id: 'local', folders: [{ id: 'native', index: 0, name: 'native', uri: URI.file('/native') }] }));
		this.services.registerInstance(IWorkspaceContextService, workspace);
		this.services.registerInstance(IFileTextModelService, models.models);
		this.services.registerInstance(IContentSearchService, { async search() { throw new Error('Filename search must not read file contents'); } });
		this.services.registerInstance(IFileSearchService, this.services.createInstance(BrowserFileSearchService));
		this.search = this._register(this.services.createInstance(SearchService));
		this.services.registerInstance(ISearchService, this.search);
		this.services.registerInstance(IChatAttachmentResolveService, this.services.createInstance(ChatAttachmentResolveService));
		this.host = this._register(WorkbenchContributionsRegistry.createHost(this.services, error => { throw error; }, ['workbench.contrib.githubFileSystemProvider']));
		this.host.advance(WorkbenchPhase.AfterRestored);
	}
}

suite('GitHub virtual repository production registration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('directory metadata, exact bytes and case-sensitive failures share one immutable tree', async () => {
		using fixture = new RepositoryFixture();
		assert.equal(fixture.files.hasProvider(root), true);
		const children = await fixture.files.readDirectory(root);
		assert.deepEqual(children.map(entry => [entry.name, entry.kind]).sort(), [['README.md', FileKind.File], ['node_modules', FileKind.Directory], ['src', FileKind.Directory]]);
		assert.deepEqual(await fixture.files.stat(file), { resource: file, kind: FileKind.File, readonly: true, sizeBytes: 4, modifiedAtMillis: undefined });
		assert.deepEqual(await fixture.files.readFileBytes(file), { resource: file, bytes: fixture.bytes, revision: sha });
		assert.deepEqual(fixture.blobRequests, [sha]);
		assert.deepEqual(fixture.treeRequests.map(request => request.reference), ['feature/files']);
		await assert.rejects(fixture.files.stat(URI.joinPath(root, 'src/MAIN.ts')), { code: FileSystemProviderErrorCode.FileNotFound });
		await assert.rejects(fixture.files.readDirectory(file), { code: FileSystemProviderErrorCode.FileNotADirectory });
		await assert.rejects(fixture.files.readFileBytes(root), { code: FileSystemProviderErrorCode.FileIsADirectory });
		await assert.rejects(async () => fixture.files.writeFile({ resource: file, content: 'changed' }), FileOperationNotSupportedError);
		assert.equal(fixture.blobRequests.length, 1);
	});

	test('Workbench filename search handles fuzzy ranking, glob intersection, exclusions, limits and native roots', async () => {
		using fixture = new RepositoryFixture();
		const query = { type: QueryType.File as const, folderQueries: [{ folder: root }], filePattern: 'main ts', sortByScore: true };
		assert.deepEqual((await fixture.search.fileSearch(query)).results.map(result => result.resource.path.slice(root.path.length + 1)), ['src/main.ts', 'src/main.test.ts']);
		const glob = await fixture.search.fileSearch({ ...query, filePattern: '**/*.ts', shouldGlobMatchFilePattern: true, includePattern: { 'src/**': true }, excludePattern: { '**/*.test.ts': true } });
		assert.deepEqual(glob.results.map(result => result.resource.toString()), [file.toString()]);
		const limited = await fixture.search.fileSearch({ ...query, filePattern: '', maxResults: 1 });
		assert.equal(limited.results.length, 1);
		assert.equal(limited.limitHit, true);
		using native = new InMemoryFileSystemProvider();
		using registration = fixture.files.registerProvider('file', native);
		await native.createDirectory(URI.file('/native'));
		await native.writeFile(URI.file('/native/main.ts'), new Uint8Array(), { create: true, overwrite: false });
		const mixed = await fixture.search.fileSearch({ ...query, folderQueries: [{ folder: root }, { folder: URI.file('/native') }] });
		assert.equal(mixed.results.length, 3);
		assert.equal(mixed.results.at(-1)?.resource.toString(), URI.file('/native/main.ts').toString());
		assert.deepEqual(fixture.blobRequests, []);
		assert.equal(fixture.treeRequests.length, 1);
	});

	test('the registered browse command opens the selected virtual file read-only', async () => {
		using fixture = new RepositoryFixture();
		using accepted = new Emitter<{ inBackground: boolean; }>();
		using hidden = new Emitter<void>();
		using changes = new Emitter<string>();
		const ready = new DeferredPromise<void>();
		let activeItems: readonly (IQuickPickItem & { resource?: URI; })[] = [];
		const picker = {
			onDidAccept: accepted.event, onDidHide: hidden.event, onDidChangeValue: changes.event, onDidTriggerItemButton: Event.None,
			ariaLabel: '', placeholder: '', sortByLabel: false,
			set items(value: readonly (IQuickPickItem & { resource?: URI; })[]) { activeItems = value.filter(item => item.resource); },
			get activeItems() { return activeItems; },
			set busy(value: boolean) { if (!value) { void ready.complete(); } },
			get busy() { return false; },
			show() { }, hide() { hidden.fire(); }, dispose() { }, [Symbol.dispose]() { },
		};
		fixture.services.registerInstance(IQuickInputService, {
			...quickInputServiceTestControls,
			input: async () => { throw new Error('Explicit repository URI must not prompt'); },
			createQuickPick: <T extends IQuickPickItem>() => picker as unknown as IQuickPick<T>,
		});
		const editors = new TestEditorService();
		fixture.services.registerInstance(IEditorService, editors);
		using notifications = new TestNotificationService();
		fixture.services.registerInstance(INotificationService, notifications);
		const command = CommandsRegistry.getCommand('sessions.github.browseRepositoryFiles')!;
		const pending = fixture.services.invokeFunction(command, root.toString());
		await Promise.race([ready.p, Promise.resolve(pending).then(() => { throw new Error('Browse closed before results'); })]);
		assert.ok(picker.ariaLabel.includes('Enter opens read-only'));
		const selected = activeItems[0].resource!;
		accepted.fire({ inBackground: false });
		await pending;
		assert.deepEqual(editors.opened, [{ resource: selected, readOnly: true }]);
	});

	test('result actions capture GitHub text in the current draft without opening or sending it', async () => {
		using fixture = new RepositoryFixture();
		using composer = new ChatAttachmentModel();
		using picker = new RepositoryPicker();
		const prior: ChatContextAttachment = { id: 'prior', kind: 'file', name: 'prior.txt', resolve: async () => ({ name: 'prior.txt', content: 'Keep existing context' }) };
		composer.addContext(prior);
		const environment = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
		const aria = setARIAContainer(environment.window.document.body);
		let focused = 0;
		fixture.currentWidget = testWidget(composer, () => { focused++; });
		const editors = installPicker(fixture, picker);
		try {
			const command = runBrowse(fixture);
			await picker.ready.p;
			const item = picker.items.find(item => item.resource?.toString() === file.toString())!;
			assert.equal(item.buttons?.[0].label, 'Add to current Agent context');
			picker.trigger.fire({ item, button: item.buttons![0] });
			await command;
			assert.equal(composer.size, 2);
			assert.equal(composer.attachments[0], prior);
			const added = composer.attachments[1];
			assert.equal(added.resource?.toString(), file.toString());
			assert.deepEqual(await added.resolve(), { name: 'main.ts', content: '\ufeffA' });
			fixture.bytes = new TextEncoder().encode('Changed after attachment');
			assert.deepEqual(await added.resolve(), { name: 'main.ts', content: '\ufeffA' });
			assert.deepEqual(fixture.blobRequests, [sha]);
			assert.deepEqual(editors.opened, []);
			assert.equal(focused, 1);
		} finally {
			aria.dispose();
			environment.window.close();
		}
	});

	for (const cancellation of ['picker', 'conversation', 'account'] as const) {
		test(`${cancellation} cancellation cannot attach a late GitHub response to another draft`, async () => {
			using fixture = new RepositoryFixture();
			using composer = new ChatAttachmentModel();
			using replacement = new ChatAttachmentModel();
			using picker = new RepositoryPicker();
			fixture.currentWidget = testWidget(composer);
			installPicker(fixture, picker);
			const read = new DeferredPromise<Uint8Array>();
			const started = new DeferredPromise<void>();
			fixture.readBlob = () => { void started.complete(); return read.p; };
			const command = runBrowse(fixture);
			await picker.ready.p;
			const item = picker.items.find(item => item.resource?.toString() === file.toString())!;
			picker.trigger.fire({ item, button: item.buttons![0] });
			await started.p;
			assert.equal(composer.hasPendingContext, true);
			if (cancellation === 'conversation') {
				composer.cancelPendingContext();
				fixture.currentWidget = testWidget(replacement);
				picker.hide();
			} else if (cancellation === 'account') { fixture.accountChanges.fire({ revision: 2n, accounts: [] }); }
			else { picker.hide(); }
			await command;
			await read.complete(new TextEncoder().encode('Late private content'));
			await Promise.resolve();
			assert.equal(composer.size, 0);
			assert.equal(replacement.size, 0);
			assert.equal(composer.hasPendingContext, false);
		});
	}

	test('AI-disabled results omit the context action and a failed read preserves the draft', async () => {
		using fixture = new RepositoryFixture();
		using composer = new ChatAttachmentModel();
		using picker = new RepositoryPicker();
		fixture.currentWidget = testWidget(composer);
		installPicker(fixture, picker);
		await fixture.configuration.updateValue('chat.disableAIFeatures', true);
		const command = runBrowse(fixture);
		await picker.ready.p;
		assert.equal(picker.items.every(item => !item.buttons?.length), true);
		assert.equal(picker.placeholder.includes('Agent'), false);
		await fixture.configuration.updateValue('chat.disableAIFeatures', false);
		const item = picker.items.find(item => item.resource?.toString() === file.toString())!;
		assert.equal(item.buttons?.length, 1);
		composer.addContext({ id: 'keep', kind: 'file', name: 'keep.txt', resolve: async () => ({ name: 'keep.txt', content: 'Original draft context' }) });
		fixture.readBlob = async () => { throw new Error('Synthetic GitHub read failure'); };
		const settled = new DeferredPromise<void>();
		using listener = composer.onDidChangePendingContext(() => { if (!composer.hasPendingContext) { void settled.complete(); } });
		picker.trigger.fire({ item, button: item.buttons![0] });
		await settled.p;
		assert.equal(composer.size, 1);
		assert.deepEqual(await composer.attachments[0].resolve(), { name: 'keep.txt', content: 'Original draft context' });
		assert.equal(picker.hidden, false);
		picker.hide();
		await command;
	});

	test('account changes cancel old reads, clear cached private metadata and cannot poison replacement reads', async () => {
		using fixture = new RepositoryFixture();
		const pending = new DeferredPromise<GitHubRepositoryTree>();
		const started = new DeferredPromise<void>();
		fixture.loadTree = () => { void started.complete(); return pending.p; };
		const old = fixture.files.readDirectory(root);
		await started.p;
		fixture.accounts = [{ ...fixture.accounts[0]!, id: 'replacement', credentialRevision: 2n }];
		fixture.accountChanges.fire({ revision: 2n, accounts: [] });
		assert.equal(fixture.treeRequests[0].token?.isCancellationRequested, true);
		fixture.loadTree = async () => ({ sha, entries: [] });
		assert.deepEqual(await fixture.files.readDirectory(root), []);
		await pending.complete(tree);
		await assert.rejects(old, isCancellationError);
		assert.deepEqual(await fixture.files.readDirectory(root), []);
		fixture.accounts = [];
		fixture.accountChanges.fire({ revision: 3n, accounts: [] });
		await assert.rejects(fixture.files.readDirectory(root), { code: FileSystemProviderErrorCode.NoPermissions });
		assert.equal(fixture.treeRequests.length, 2);
	});

	test('search cancellation returns promptly and contribution disposal removes routing and cancels reads', async () => {
		using fixture = new RepositoryFixture();
		const pending = new DeferredPromise<GitHubRepositoryTree>();
		const started = new DeferredPromise<void>();
		fixture.loadTree = () => { void started.complete(); return pending.p; };
		using source = new CancellationTokenSource();
		const search = fixture.search.fileSearch({ type: QueryType.File, folderQueries: [{ folder: root }] }, source.token);
		await started.p;
		source.cancel();
		await assert.rejects(search, isCancellationError);
		fixture.host.dispose();
		assert.equal(fixture.files.hasProvider(root), false);
		assert.equal(fixture.treeRequests[0].token?.isCancellationRequested, true);
		await pending.complete(tree);
		await assert.rejects(fixture.search.fileSearch({ type: QueryType.File, folderQueries: [{ folder: root }] }), RangeError);
	});

	test('repository errors and command labels use the selected non-default language', async () => {
		using fixture = new RepositoryFixture();
		fixture.accounts = [];
		setNlsMessages('zh-CN', translatedGitHub);
		try {
			assert.equal(localize('github.files.browse', ''), 'GitHub: 浏览仓库文件');
			await assert.rejects(fixture.files.stat(root), error => error instanceof Error && error.message === '请登录有权访问此仓库的 GitHub 账号。');
		} finally { resetNlsResolver(); }
	});
});

interface RepositoryPick extends IQuickPickItem { readonly resource?: URI; }

class RepositoryPicker extends Disposable {
	public readonly ready = new DeferredPromise<void>();
	public readonly trigger = this._register(new Emitter<{ item: RepositoryPick; button: IQuickPickItemButton; }>());
	private readonly hides = this._register(new Emitter<void>());
	public readonly onDidHide = this.hides.event;
	public readonly onDidTriggerItemButton = this.trigger.event;
	public readonly onDidAccept = Event.None;
	public readonly onDidChangeValue = Event.None;
	public items: readonly RepositoryPick[] = [];
	public activeItems: readonly RepositoryPick[] = [];
	public ariaLabel = '';
	public placeholder = '';
	public sortByLabel = false;
	public hidden = false;
	private loading = false;
	public get busy(): boolean { return this.loading; }
	public set busy(value: boolean) { this.loading = value; if (!value) { void this.ready.complete(); } }
	public show(): void { }
	public hide(): void { this.hidden = true; this.hides.fire(); }
}

function installPicker(fixture: RepositoryFixture, picker: RepositoryPicker): TestEditorService {
	fixture.services.registerInstance(IQuickInputService, {
		...quickInputServiceTestControls,
		input: async () => { throw new Error('Explicit repository must not prompt'); },
		createQuickPick: <T extends IQuickPickItem>() => picker as unknown as IQuickPick<T>,
	});
	const editors = new TestEditorService();
	fixture.services.registerInstance(IEditorService, editors);
	fixture.services.registerInstance(INotificationService, fixture.notifications);
	return editors;
}

function runBrowse(fixture: RepositoryFixture): unknown {
	return fixture.services.invokeFunction(CommandsRegistry.getCommand('sessions.github.browseRepositoryFiles')!, root.toString());
}

function testWidget(model: ChatAttachmentModel, focus: () => void = () => { }): IChatWidget {
	return {
		sessionId: undefined, threadId: undefined, visible: true,
		domNode: undefined as unknown as HTMLElement,
		inputEditor: { focus } as ICodeEditor,
		isTranscriptProgressActive: false, onDidChangeVisibility: Event.None,
		onDidHide: Event.None, onDidChangeViewModel: Event.None,
		acquireContext: (prepare, signal) => model.acquireContext(prepare, signal),
		startVoiceConversation: async () => { throw new Error('Context must not start voice'); },
	};
}
