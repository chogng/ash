import type { IResourceEditorInput } from '../../../../common/editor.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { MenuId, MenusRegistry, isMenuItem } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { OpenerService } from '../../../../../editor/browser/services/openerService.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { StandaloneCodeEditorService } from '../../../../../editor/standalone/browser/standaloneCodeEditorService.js';
import { IQuickInputService, type IQuickPickItem, type IQuickPick, type IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { formatNlsMessage, resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import type { SCMHistoryItemViewModelTreeElement, ISCMHistoryItem } from '../../../scm/common/history.js';
import { ISCMService, ISCMViewService, SCMProviderContext, SCMBusyContext, type ISCMRepository } from '../../../scm/common/scm.js';
import { SCMService } from '../../../scm/common/scmService.js';
import { SCMViewService } from '../../../scm/browser/scmViewService.js';
import { isMultiDiffEditorInput } from '../../../multiDiffEditor/browser/multiDiffEditorInput.js';
import { GitHistoryProvider } from '../../browser/gitHistoryProvider.js';
import { GitSCMProvider, type GitSCMProviderServices } from '../../browser/gitSCMProvider.js';
import { IGitService, type GitCatalog, type GitCommand, type GitStatus } from '../../common/gitService.js';
import '../../browser/git.contribution.js';
import '../../../scm/browser/scmHistoryViewPane.js';

const selectedId = '2'.repeat(40);
const firstParent = '1'.repeat(40);
const baseId = '3'.repeat(40);

function historyElement(item: Partial<ISCMHistoryItem> = {}, provider?: GitHistoryProvider): SCMHistoryItemViewModelTreeElement {
	return {
		type: 'historyItemViewModel',
		repository: { id: 'repo-selected', provider: { id: 'repo-selected', providerId: 'git', historyProvider: provider } } as unknown as ISCMRepository,
		historyItemViewModel: { historyItem: { id: selectedId, displayId: selectedId.slice(0, 7), subject: 'Selected', message: 'Selected', parentIds: [firstParent], ...item }, inputSwimlanes: [], outputSwimlanes: [], kind: 'node' },
	};
}

function inputSelecting(index: number, inputValue?: string, prompts?: string[], shown?: (items: readonly (IQuickPickItem | IQuickPickSeparator)[], placeholder: string, ariaLabel: string) => void): IQuickInputService {
	return {
		input: async options => { prompts?.push(options.placeHolder ?? ''); return inputValue; },
		createQuickPick: <T extends IQuickPickItem>() => {
			const accept = new Emitter<T>();
			const hide = new Emitter<void>();
			const picker = {
				items: [] as readonly (T | IQuickPickSeparator)[],
				placeholder: '', ariaLabel: '',
				onDidAccept: accept.event, onDidHide: hide.event,
				show(): void {
					shown?.(this.items, this.placeholder, this.ariaLabel);
					const items = this.items.filter((item): item is T => !('type' in item && item.type === 'separator'));
					queueMicrotask(() => index < 0 ? hide.fire() : accept.fire(items[index]));
				},
				hide(): void { hide.fire(); },
				dispose(): void { accept.dispose(); hide.dispose(); },
				[Symbol.dispose](): void { this.dispose(); },
			};
			return picker as unknown as IQuickPick<T>;
		},
	} as IQuickInputService;
}

function registerGraphServices(services: InstantiationService, git: Partial<IGitService>, messages: string[] = []): void {
	services.registerInstance(IGitService, git as IGitService);
	services.registerInstance(ISCMService, { getRepository: () => undefined } as unknown as ISCMService);
	services.registerInstance(ISCMViewService, { activeRepository: undefined } as unknown as ISCMViewService);
	services.registerInstance(INotificationService, {
		info: message => { messages.push(String(message)); },
		warning: message => { messages.push(String(message)); },
		error: message => { messages.push(String(message)); },
	} as INotificationService);
}

ensureNoDisposablesAreLeakedInTestSuite();

function commitFixture(overrides: Partial<IGitService> = {}, confirm: () => Promise<{ confirmed: boolean; }> = async () => ({ confirmed: true }), quickInput: IQuickInputService = inputSelecting(0)): { provider: GitSCMProvider; commands: CommandService; requests: unknown[][]; status: GitStatus; views: SCMViewService; scm: SCMService;[Symbol.dispose](): void; } {
	const lifetime = new DisposableStore();
	const dependencies = lifetime.add(new InstantiationService());
	const services = lifetime.add(dependencies.createChild());
	const scm = lifetime.add(new SCMService());
	const views = lifetime.add(new SCMViewService(scm));
	const repository = { id: 'commit-repo', label: 'Commit repository', path: '.', root: URI.file('/workspace') };
	const status: GitStatus = {
		repositoryId: repository.id, streamInstanceId: 'commit-stream', revision: 1, workspacePath: '/workspace',
		head: { type: 'branch', name: 'main', objectId: selectedId, upstream: undefined },
		changes: [{ path: 'tracked.ts', originalPath: undefined, indexStatus: 'modified', worktreeStatus: 'modified', conflicted: false, submodule: { isSubmodule: false, commitChanged: false, trackedChanges: false, untrackedChanges: false } }],
	};
	const requests: unknown[][] = [];
	const git: Partial<IGitService> = {
		onDidChangeRepositoryStatus: Event.None, onDidBecomeReady: Event.None,
		getRepository: async () => repository,
		status: async () => status,
		commit: async (...args) => { requests.push(['commit', ...args]); return { objectId: baseId, status: { ...status, revision: 2, changes: [] } }; },
		commitMessage: async (...args) => { requests.push(['message', ...args]); return 'Previous subject\n\nPrevious body.\n'; },
		executeCommand: async (...args) => { requests.push(['command', ...args]); return { outcome: 'completed', operation: undefined, status: { ...status, revision: 2 } }; },
		...overrides,
	};
	registerGraphServices(dependencies, git);
	const dialogs = { confirm } as unknown as IDialogService;
	services.registerInstance(IDialogService, dialogs);
	services.registerInstance(IQuickInputService, quickInput);
	services.registerInstance(ISCMService, scm);
	services.registerInstance(ISCMViewService, views);
	const history = lifetime.add(new GitHistoryProvider(git as IGitService, repository.id));
	const provider = lifetime.add(new GitSCMProvider(git as IGitService, repository, history, { dialogService: dialogs } as GitSCMProviderServices));
	lifetime.add(scm.registerSCMProvider(provider));
	const commands = lifetime.add(new CommandService(services));
	return { provider, commands, requests, status, views, scm, [Symbol.dispose]: () => lifetime.dispose() };
}

for (const edit of ['new text', 'edit and restore']) {
	test(`SCM commit workflow keeps a newer draft after success: ${edit}`, async () => {
		const started = new DeferredPromise<void>();
		const completed = new DeferredPromise<{ objectId: string; status: GitStatus; }>();
		using fixture = commitFixture({ commit: async () => { await started.complete(); return completed.p; } });
		await fixture.provider.refresh();
		fixture.provider.input.value = 'Original subject';
		const operation = fixture.provider.input.accept();
		await started.p;
		fixture.provider.input.value = 'Next draft';
		if (edit === 'edit and restore') fixture.provider.input.value = 'Original subject';
		await completed.complete({ objectId: baseId, status: { ...fixture.status, revision: 2, changes: [] } });
		await operation;
		assert.deepEqual({ draft: fixture.provider.input.value, busy: fixture.provider.isBusy }, { draft: edit === 'new text' ? 'Next draft' : 'Original subject', busy: false });
	});
}

test('SCM commit workflow does not clear a disposed repository draft', async () => {
	const started = new DeferredPromise<void>();
	const completed = new DeferredPromise<{ objectId: string; status: GitStatus; }>();
	using fixture = commitFixture({ commit: async () => { await started.complete(); return completed.p; } });
	await fixture.provider.refresh();
	fixture.provider.input.value = 'Keep disposed draft';
	const operation = fixture.provider.input.accept();
	await started.p;
	fixture.provider.dispose();
	await completed.complete({ objectId: baseId, status: { ...fixture.status, revision: 2, changes: [] } });
	await operation;
	assert.equal(fixture.provider.input.value, 'Keep disposed draft');
});

test('SCM commit workflow refreshes the real index after failure and keeps its draft', async () => {
	let failed = false;
	using fixture = commitFixture({
		commit: async () => { failed = true; throw new Error('Commit failed after staging'); },
		status: async () => {
			await Promise.resolve();
			return { ...fixture.status, revision: failed ? 2 : 1, changes: failed ? [{ ...fixture.status.changes[0], path: 'actually-staged.ts' }] : fixture.status.changes };
		},
	});
	await fixture.provider.refresh();
	fixture.provider.input.value = 'Retry this message';
	await fixture.provider.input.accept();
	assert.deepEqual({ draft: fixture.provider.input.value, staged: fixture.provider.groups.find(group => group.id === 'staged')?.resources.map(resource => resource.path), message: fixture.provider.statusMessage, busy: fixture.provider.isBusy }, {
		draft: 'Retry this message', staged: ['actually-staged.ts'], message: 'Commit failed after staging', busy: false,
	});
});

for (const [id, options] of [
	['git.commitStaged', { scope: 'staged' }],
	['git.commitStagedSigned', { scope: 'staged', signoff: 'add' }],
	['git.commitAll', { scope: 'tracked' }],
	['git.commitAllSigned', { signoff: 'add', scope: 'tracked' }],
	['git.commitStagedAmend', { scope: 'staged', mode: 'amend' }],
	['git.commitAllAmend', { mode: 'amend', scope: 'tracked' }],
] as const) {
	test(`SCM commit workflow routes ${id} through the repository draft and explicit scope`, async () => {
		using fixture = commitFixture();
		await fixture.provider.refresh();
		fixture.provider.input.value = 'One repository draft';
		await fixture.commands.executeCommand(id, fixture.provider.id);
		assert.deepEqual({ requests: fixture.requests, draft: fixture.provider.input.value, busy: fixture.provider.isBusy }, {
			requests: [['commit', 'One repository draft', fixture.provider.id, options]], draft: '', busy: false,
		});
	});
}

test('SCM commit workflow undo restores the complete message to an unchanged empty draft', async () => {
	using fixture = commitFixture();
	await fixture.provider.refresh();
	await fixture.commands.executeCommand('git.undoCommit', fixture.provider.id);
	assert.deepEqual({ draft: fixture.provider.input.value, requests: fixture.requests }, {
		draft: 'Previous subject\n\nPrevious body.\n',
		requests: [['message', selectedId, fixture.provider.id], ['command', { kind: 'undoCommit', expectedHead: selectedId }, fixture.provider.id]],
	});
});

test('SCM commit workflow requires an explicit choice before including untracked files', async () => {
	const choices: string[][] = [];
	using fixture = commitFixture({}, undefined, inputSelecting(1, undefined, undefined, items => choices.push(items.map(item => item.label ?? ''))));
	await fixture.provider.refresh();
	fixture.provider.input.value = 'Include the new file';
	await fixture.commands.executeCommand('git.commitAll', fixture.provider.id);
	assert.deepEqual(choices, [['Tracked changes only', 'Tracked and untracked changes']]);
	assert.deepEqual(fixture.requests, [['commit', 'Include the new file', fixture.provider.id, { scope: 'includeUntracked' }]]);
});

test('SCM commit workflow cancels the scope picker without mutation or draft loss', async () => {
	using fixture = commitFixture({}, undefined, inputSelecting(-1));
	await fixture.provider.refresh();
	fixture.provider.input.value = 'Keep cancelled draft';
	await fixture.commands.executeCommand('git.commitAllSigned', fixture.provider.id);
	assert.deepEqual({ requests: fixture.requests, draft: fixture.provider.input.value, busy: fixture.provider.isBusy }, {
		requests: [], draft: 'Keep cancelled draft', busy: false,
	});
});

test('SCM commit workflow owns busy state while selecting scope and cancels after a newer edit', async () => {
	const selecting = new DeferredPromise<void>();
	const scope = new DeferredPromise<'tracked'>();
	using fixture = commitFixture();
	await fixture.provider.refresh();
	fixture.provider.input.value = 'Original';
	const operation = fixture.provider.commit({}, async () => { await selecting.complete(); return scope.p; });
	await selecting.p;
	assert.equal(fixture.provider.isBusy, true);
	await fixture.provider.input.accept();
	fixture.provider.input.value = 'Newer';
	await scope.complete('tracked');
	await operation;
	assert.deepEqual({ requests: fixture.requests, draft: fixture.provider.input.value, busy: fixture.provider.isBusy }, { requests: [], draft: 'Newer', busy: false });
});

for (const confirmed of [false, true]) {
	test(`SCM commit workflow amend loads the complete previous message and ${confirmed ? 'commits' : 'keeps it after cancellation'}`, async () => {
		using fixture = commitFixture({}, async () => ({ confirmed }));
		await fixture.provider.refresh();
		await fixture.commands.executeCommand('git.commitAmend', fixture.provider.id);
		assert.deepEqual({ requests: fixture.requests, draft: fixture.provider.input.value, busy: fixture.provider.isBusy }, {
			requests: [['message', selectedId, fixture.provider.id], ...(confirmed ? [['commit', 'Previous subject\n\nPrevious body.', fixture.provider.id, { mode: 'amend' }]] : [])],
			draft: confirmed ? '' : 'Previous subject\n\nPrevious body.\n', busy: false,
		});
	});
}

test('SCM commit workflow amend cancels after an edit during confirmation', async () => {
	const opened = new DeferredPromise<void>();
	const decision = new DeferredPromise<{ confirmed: boolean; }>();
	using fixture = commitFixture({}, async () => { await opened.complete(); return decision.p; });
	await fixture.provider.refresh();
	fixture.provider.input.value = 'Amended message';
	const operation = fixture.commands.executeCommand('git.commitAmend', fixture.provider.id);
	await opened.p;
	assert.equal(fixture.provider.isBusy, true);
	fixture.provider.input.value = 'Future message';
	await decision.complete({ confirmed: true });
	await operation;
	assert.deepEqual({ requests: fixture.requests, draft: fixture.provider.input.value, busy: fixture.provider.isBusy }, { requests: [], draft: 'Future message', busy: false });
});

for (const initial of ['', 'Existing draft']) {
	test(`SCM commit workflow undo preserves newer text while awaiting confirmation: ${initial || 'empty'}`, async () => {
		const opened = new DeferredPromise<void>();
		const decision = new DeferredPromise<{ confirmed: boolean; }>();
		using fixture = commitFixture({}, async () => { await opened.complete(); return decision.p; });
		await fixture.provider.refresh();
		fixture.provider.input.value = initial;
		const operation = fixture.commands.executeCommand('git.undoCommit', fixture.provider.id);
		await opened.p;
		fixture.provider.input.value = 'New message';
		await decision.complete({ confirmed: true });
		await operation;
		assert.equal(fixture.provider.input.value, 'New message');
		assert.equal(fixture.provider.statusMessage, 'Last commit undone. Your current Source Control draft was kept.');
	});
}

test('SCM commit workflow undo preserves an existing unchanged draft', async () => {
	using fixture = commitFixture();
	await fixture.provider.refresh();
	fixture.provider.input.value = 'Existing message';
	await fixture.commands.executeCommand('git.undoCommit', fixture.provider.id);
	assert.equal(fixture.provider.input.value, 'Existing message');
});

test('SCM commit workflow undo cancellation only reads the captured commit message', async () => {
	using fixture = commitFixture({}, async () => ({ confirmed: false }));
	await fixture.provider.refresh();
	await fixture.commands.executeCommand('git.undoCommit', fixture.provider.id);
	assert.deepEqual({ requests: fixture.requests, draft: fixture.provider.input.value, busy: fixture.provider.isBusy }, {
		requests: [['message', selectedId, fixture.provider.id]], draft: '', busy: false,
	});
});

test('SCM commit workflow releases busy state and leaves the draft empty after an undo failure', async () => {
	using fixture = commitFixture({ executeCommand: async () => { throw new Error('GitHeadChanged'); } });
	await fixture.provider.refresh();
	await fixture.commands.executeCommand('git.undoCommit', fixture.provider.id);
	assert.deepEqual({ draft: fixture.provider.input.value, message: fixture.provider.statusMessage, busy: fixture.provider.isBusy }, { draft: '', message: 'GitHeadChanged', busy: false });
});

test('SCM commit workflow rejects blank creation and amendment of an unborn repository', async () => {
	using fixture = commitFixture();
	await fixture.provider.refresh();
	await fixture.provider.input.accept();
	assert.equal(fixture.provider.statusMessage, 'Enter a commit message.');
	using unborn = commitFixture({ status: async () => ({ ...fixture.status, head: { type: 'unborn', name: 'main' } }) });
	await unborn.provider.refresh();
	await unborn.commands.executeCommand('git.commitAmend', unborn.provider.id);
	assert.deepEqual({ requests: fixture.requests.concat(unborn.requests), message: unborn.provider.statusMessage, busy: unborn.provider.isBusy }, { requests: [], message: 'There is no commit to amend.', busy: false });
});

test('SCM commit workflow keeps its repository across a switch during confirmation', async () => {
	const opened = new DeferredPromise<void>();
	const decision = new DeferredPromise<{ confirmed: boolean; }>();
	using first = commitFixture({}, async () => { await opened.complete(); return decision.p; });
	using history = new GitHistoryProvider({ onDidBecomeReady: Event.None, onDidChangeRepositoryStatus: Event.None } as IGitService, 'other-repo');
	using other = new GitSCMProvider({ onDidChangeRepositoryStatus: Event.None, onDidBecomeReady: Event.None, status: async () => ({ ...first.status, repositoryId: 'other-repo' }) } as IGitService,
		{ id: 'other-repo', label: 'Other', path: 'other', root: URI.file('/workspace/other') }, history, {} as GitSCMProviderServices);
	using registration = first.scm.registerSCMProvider(other);
	await first.provider.refresh();
	await other.refresh();
	first.provider.input.value = 'Captured message';
	other.input.value = 'Other draft';
	const operation = first.commands.executeCommand('git.commitAmend', first.provider.id);
	await opened.p;
	first.views.selectRepository(other.id);
	assert.deepEqual([first.provider.isBusy, other.isBusy], [true, false]);
	await decision.complete({ confirmed: true });
	await operation;
	assert.deepEqual({ requests: first.requests, first: first.provider.input.value, other: other.input.value }, {
		requests: [['commit', 'Captured message', first.provider.id, { mode: 'amend' }]], first: '', other: 'Other draft',
	});
});

test('SCM commit workflow undo does not restore after editing back to an empty draft', async () => {
	const opened = new DeferredPromise<void>();
	const decision = new DeferredPromise<{ confirmed: boolean; }>();
	using fixture = commitFixture({}, async () => { await opened.complete(); return decision.p; });
	await fixture.provider.refresh();
	const operation = fixture.commands.executeCommand('git.undoCommit', fixture.provider.id);
	await opened.p;
	fixture.provider.input.value = 'An intentional edit';
	fixture.provider.input.value = '';
	await decision.complete({ confirmed: true });
	await operation;
	assert.deepEqual({ draft: fixture.provider.input.value, message: fixture.provider.statusMessage }, { draft: '', message: 'Last commit undone. Your current Source Control draft was kept.' });
});

for (const locale of ['en', 'zh-CN']) {
	test(`SCM commit workflow describes explicit untracked selection and draft preservation in ${locale}`, async () => {
		const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale === locale)!;
		setNlsResolver((bundle, key, original, parameters) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? original, parameters));
		try {
			const choices: string[][] = [];
			using fixture = commitFixture({}, undefined, inputSelecting(-1, undefined, undefined, items => choices.push(items.map(item => item.label ?? ''))));
			await fixture.provider.refresh();
			fixture.provider.input.value = 'Keep draft';
			await fixture.commands.executeCommand('git.commitAll', fixture.provider.id);
			assert.deepEqual(choices, [locale === 'zh-CN' ? ['仅已跟踪的更改', '已跟踪和未跟踪的更改'] : ['Tracked changes only', 'Tracked and untracked changes']]);
			await fixture.commands.executeCommand('git.undoCommit', fixture.provider.id);
			assert.equal(fixture.provider.statusMessage, locale === 'zh-CN' ? '已撤销上次提交，并保留当前源代码管理草稿。' : 'Last commit undone. Your current Source Control draft was kept.');
		} finally { resetNlsResolver(); }
	});
}

for (const menuId of [MenuId.SCMTitle, MenuId.for('git.pullpush')]) {
	for (const cancelled of [false, true]) {
		test(`${menuId.id} Fetch executes its captured repository and releases provider busy state after ${cancelled ? 'catalog cancellation' : 'fetch failure'}`, async () => {
			const requests: unknown[][] = [];
			const catalogStarted = new DeferredPromise<void>();
			const catalog = new DeferredPromise<GitCatalog>();
			using dependencies = new InstantiationService();
			using services = dependencies.createChild();
			using scm = new SCMService();
			using views = new SCMViewService(scm);
			using context = new ContextKeyService();
			SCMProviderContext.bindTo(context).set('git');
			SCMBusyContext.bindTo(context).set(false);
			const repository = { id: 'first', label: 'First', path: '.', root: URI.file('/workspace') };
			const git: Partial<IGitService> = {
				onDidChangeRepositoryStatus: Event.None, onDidBecomeReady: Event.None,
				getRepository: async repositoryId => { requests.push(['repository', repositoryId]); return repository; },
				status: async repositoryId => ({ repositoryId: repositoryId!, streamInstanceId: 'stream', revision: 1, workspacePath: '/workspace', head: { type: 'unborn', name: 'main' }, changes: [] }),
				catalog: async repositoryId => { requests.push(['catalog', repositoryId]); await catalogStarted.complete(); return catalog.p; },
				fetch: async repositoryId => { requests.push(['fetch', repositoryId]); throw new Error('GitOperationFailed'); },
			};
			registerGraphServices(dependencies, git);
			using history = new GitHistoryProvider(git as IGitService, repository.id);
			using provider = new GitSCMProvider(git as IGitService, repository, history, {} as GitSCMProviderServices);
			using first = scm.registerSCMProvider(provider);
			using secondHistory = new GitHistoryProvider(git as IGitService, 'second');
			using secondProvider = new GitSCMProvider(git as IGitService, { ...repository, id: 'second' }, secondHistory, {} as GitSCMProviderServices);
			using second = scm.registerSCMProvider(secondProvider);
			services.registerInstance(ISCMService, scm);
			services.registerInstance(ISCMViewService, views);
			using commands = new CommandService(services);
			const menus = new MenuService(commands, context);
			const actions = menus.getMenuActions(menuId, { arg: first.id }).flatMap(([, actions]) => actions);
			const fetch = actions.filter(action => action.id === 'git.fetchAll');
			assert.equal(fetch.length, 1);
			assert.equal(actions.some(action => action.id === 'ash.git.fetch'), false);
			views.selectRepository(second.id);
			const operation = fetch[0].run();
			await catalogStarted.p;
			assert.deepEqual([provider.isBusy, secondProvider.isBusy], [true, false]);
			views.selectRepository(first.id);
			views.selectRepository(second.id);
			if (cancelled) await catalog.error(new CancellationError());
			else await catalog.complete({ tags: [], stashes: [], remotes: ['origin'], operation: undefined });
			await operation;
			assert.deepEqual({ requests, busy: provider.isBusy, message: provider.statusMessage }, {
				requests: cancelled ? [['repository', 'first'], ['catalog', 'first']] : [['repository', 'first'], ['catalog', 'first'], ['fetch', 'first']],
				busy: false, message: cancelled ? 'Operation cancelled' : 'GitOperationFailed',
			});
		});
	}
}

test('Fetch From All Remotes runs from the command palette and keeps its repository across catalog reads', async () => {
	const requests: unknown[][] = [];
	const repositoryStarted = new DeferredPromise<void>();
	const repositoryReady = new DeferredPromise<void>();
	const catalogStarted = new DeferredPromise<void>();
	const catalog = new DeferredPromise<GitCatalog>();
	let activeRepository = 'repo-selected';
	using services = new InstantiationService();
	registerGraphServices(services, {
		get activeRepository() { return { id: activeRepository, label: 'Repository', path: '.', root: URI.file('/workspace') }; },
		getRepository: async repositoryId => {
			requests.push(['repository', repositoryId]);
			await repositoryStarted.complete();
			await repositoryReady.p;
			return { id: repositoryId!, label: 'Repository', path: '.', root: URI.file('/workspace') };
		},
		catalog: async repositoryId => { requests.push(['catalog', repositoryId]); await catalogStarted.complete(); return catalog.p; },
		fetch: async repositoryId => { requests.push(['fetch', repositoryId]); return {} as GitStatus; },
	});
	using commands = new CommandService(services);
	const result = commands.executeCommand('git.fetchAll');
	await repositoryStarted.p;
	activeRepository = 'repo-other';
	await repositoryReady.complete();
	await catalogStarted.p;
	await catalog.complete({ tags: [], stashes: [], remotes: ['origin', 'backup'], operation: undefined });
	await result;
	assert.deepEqual(requests, [['repository', 'repo-selected'], ['catalog', 'repo-selected'], ['fetch', 'repo-selected']]);
	const item = MenusRegistry.getMenuItems(MenuId.CommandPalette).find(item => isMenuItem(item) && item.command.id === 'git.fetchAll');
	assert.ok(item && isMenuItem(item));
	assert.deepEqual(item.command.title, { original: 'Git: Fetch From All Remotes', value: 'Git: Fetch From All Remotes' });
	assert.equal(CommandsRegistry.getCommand('ash.git.fetch'), undefined);
});

test('Fetch From All Remotes uses the invoking toolbar repository and releases its busy state on failure', async () => {
	const requests: unknown[][] = [];
	const messages: string[] = [];
	let busy = false;
	using services = new InstantiationService();
	registerGraphServices(services, {
		getRepository: async repositoryId => {
			requests.push(['repository', repositoryId]);
			return { id: repositoryId!, label: 'Repository', path: '.', root: URI.file('/workspace') };
		},
		catalog: async repositoryId => { requests.push(['catalog', repositoryId]); return { tags: [], stashes: [], remotes: ['origin'], operation: undefined }; },
		fetch: async repositoryId => { requests.push(['fetch', repositoryId, busy]); throw new Error('GitOperationFailed'); },
	}, messages);
	using commands = new CommandService(services);
	await commands.executeCommand('git.fetchAll', {
		repositoryId: 'repo-toolbar',
		runTitleOperation: async (operation: () => Promise<unknown>) => {
			busy = true;
			try { await operation(); } finally { busy = false; }
		},
	});
	assert.deepEqual({ requests, messages, busy }, {
		requests: [['repository', 'repo-toolbar'], ['catalog', 'repo-toolbar'], ['fetch', 'repo-toolbar', true]],
		messages: ['GitOperationFailed'], busy: false,
	});
});

test('Fetch From All Remotes reports catalog failures without sending a fetch request', async () => {
	const messages: string[] = [];
	let fetches = 0;
	using services = new InstantiationService();
	registerGraphServices(services, {
		getRepository: async () => ({ id: 'repo', label: 'Repository', path: '.', root: URI.file('/workspace') }),
		catalog: async () => { throw new Error('GitUnavailable'); },
		fetch: async () => { fetches++; return {} as GitStatus; },
	}, messages);
	using commands = new CommandService(services);
	await commands.executeCommand('git.fetchAll');
	assert.deepEqual({ fetches, messages }, { fetches: 0, messages: ['Git is unavailable for this workspace. Check folder access and retry.'] });
});

for (const locale of ['en', 'zh-CN']) {
	test(`Fetch From All Remotes explains the absence of remotes in ${locale} without fetching`, async () => {
		const messages: string[] = [];
		let fetches = 0;
		const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale === locale)!;
		setNlsResolver((bundle, key, original, parameters) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? original, parameters));
		try {
			using services = new InstantiationService();
			registerGraphServices(services, {
				getRepository: async repositoryId => ({ id: repositoryId!, label: 'Repository', path: '.', root: URI.file('/workspace') }),
				catalog: async () => ({ tags: [], stashes: [], remotes: [], operation: undefined }),
				fetch: async () => { fetches++; return {} as GitStatus; },
			}, messages);
			using commands = new CommandService(services);
			await commands.executeCommand('git.fetchAll', 'repo-explicit');
			assert.deepEqual({ fetches, messages }, { fetches: 0, messages: [locale === 'zh-CN' ? '此仓库未配置可获取的远端。' : 'This repository has no remotes configured to fetch from.'] });
		} finally { resetNlsResolver(); }
	});
}

test('Fetch uses the default mode for one remote without showing a picker', async () => {
	const requests: unknown[][] = [];
	using services = new InstantiationService();
	registerGraphServices(services, {
		getRepository: async repositoryId => ({ id: repositoryId!, label: 'Repository', path: '.', root: URI.file('/workspace') }),
		catalog: async repositoryId => { requests.push(['catalog', repositoryId]); return { tags: [], stashes: [], remotes: ['backup'], operation: undefined }; },
		fetch: async (repositoryId, target) => { requests.push(['fetch', repositoryId, target]); return {} as GitStatus; },
	});
	using commands = new CommandService(services);
	await commands.executeCommand('git.fetch', 'repo-selected');
	assert.deepEqual(requests, [['catalog', 'repo-selected'], ['fetch', 'repo-selected', 'default']]);
	const item = MenusRegistry.getMenuItems(MenuId.CommandPalette).find(item => isMenuItem(item) && item.command.id === 'git.fetch');
	assert.ok(item && isMenuItem(item));
	assert.deepEqual(item.command.title, { original: 'Git: Fetch', value: 'Git: Fetch' });
});

test('Fetch warns about an empty remote list without showing a picker or fetching', async () => {
	const messages: string[] = [];
	let fetches = 0;
	using services = new InstantiationService();
	registerGraphServices(services, {
		getRepository: async () => ({ id: 'repo-selected', label: 'Repository', path: '.', root: URI.file('/workspace') }),
		catalog: async () => ({ tags: [], stashes: [], remotes: [], operation: undefined }),
		fetch: async () => { fetches++; return {} as GitStatus; },
	}, messages);
	using commands = new CommandService(services);
	await commands.executeCommand('git.fetch');
	assert.deepEqual({ fetches, messages }, { fetches: 0, messages: ['This repository has no remotes configured to fetch from.'] });
});

for (const [index, target] of [[0, { remote: 'team/backup' }], [1, { remote: 'aaa' }], [2, 'all'], [-1, undefined]] as const) {
	for (const locale of ['en', 'zh-CN']) {
		test(`Fetch selects ${JSON.stringify(target)} in ${locale} and keeps its repository while the picker is open`, async () => {
			const requests: unknown[][] = [];
			let activeRepository = 'repo-selected';
			const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale === locale)!;
			setNlsResolver((bundle, key, original, parameters) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? original, parameters));
			try {
				using services = new InstantiationService();
				registerGraphServices(services, {
					get activeRepository() { return { id: activeRepository, label: 'Repository', path: '.', root: URI.file('/workspace') }; },
					getRepository: async repositoryId => { requests.push(['repository', repositoryId]); return { id: repositoryId!, label: 'Repository', path: '.', root: URI.file('/workspace') }; },
					catalog: async repositoryId => { requests.push(['catalog', repositoryId]); return { tags: [], stashes: [], remotes: ['aaa', 'team/backup'], upstreamRemote: 'team/backup', operation: undefined }; },
					fetch: async (repositoryId, target) => { requests.push(['fetch', repositoryId, target]); return {} as GitStatus; },
				});
				services.registerInstance(IQuickInputService, inputSelecting(index, undefined, undefined, (items, placeholder, ariaLabel) => {
					activeRepository = 'repo-other';
					const prompt = locale === 'zh-CN' ? '选择要获取的远端' : 'Select a remote to fetch';
					assert.equal(placeholder, prompt);
					assert.equal(ariaLabel, prompt);
					assert.deepEqual(items.map(item => 'type' in item ? item.type : item.label), ['team/backup', 'aaa', 'separator', locale === 'zh-CN' ? '获取所有远端' : 'Fetch all remotes']);
				}));
				using commands = new CommandService(services);
				await commands.executeCommand('git.fetch');
				const expected: unknown[][] = [['repository', 'repo-selected'], ['catalog', 'repo-selected']];
				if (target) { expected.push(['fetch', 'repo-selected', target]); }
				assert.deepEqual(requests, expected);
			} finally { resetNlsResolver(); }
		});
	}
}

for (const cancel of [false, true]) {
	test(`Fetch releases the invoking provider after picker ${cancel ? 'cancellation' : 'fetch failure'}`, async () => {
		using dependencies = new InstantiationService();
		using services = dependencies.createChild();
		using scm = new SCMService();
		using views = new SCMViewService(scm);
		const repository = { id: 'repo-selected', label: 'Repository', path: '.', root: URI.file('/workspace') };
		let fetches = 0;
		const git: Partial<IGitService> = {
			onDidChangeRepositoryStatus: Event.None, onDidBecomeReady: Event.None,
			getRepository: async () => repository,
			status: async () => ({ repositoryId: repository.id, streamInstanceId: 'stream', revision: 1, workspacePath: '/workspace', head: { type: 'unborn', name: 'main' }, changes: [] }),
			catalog: async () => ({ tags: [], stashes: [], remotes: ['backup', 'origin'], operation: undefined }),
			fetch: async () => { fetches++; throw new Error('GitOperationFailed'); },
		};
		registerGraphServices(dependencies, git);
		using history = new GitHistoryProvider(git as IGitService, repository.id);
		using provider = new GitSCMProvider(git as IGitService, repository, history, {} as GitSCMProviderServices);
		using registered = scm.registerSCMProvider(provider);
		services.registerInstance(ISCMService, scm);
		services.registerInstance(ISCMViewService, views);
		services.registerInstance(IQuickInputService, inputSelecting(cancel ? -1 : 0, undefined, undefined, () => assert.equal(provider.isBusy, true)));
		using commands = new CommandService(services);
		await commands.executeCommand('git.fetch', registered.id);
		assert.equal(provider.isBusy, false);
		assert.equal(fetches, cancel ? 0 : 1);
		if (!cancel) assert.equal(provider.statusMessage, 'GitOperationFailed');
	});
}

test('Graph copies the full message and opens the selected commit on its hosting platform', async () => {
	const writes: string[] = [];
	const reads: unknown[][] = [];
	using services = new InstantiationService();
	registerGraphServices(services, { commitMessage: async (...args) => { reads.push(args); return 'Selected\n\nThe complete body.'; } });
	services.registerInstance(IQuickInputService, inputSelecting(0));
	services.registerInstance(IClipboardService, { writeText: async text => { writes.push(text); } } as IClipboardService);
	using codeEditors = new StandaloneCodeEditorService();
	services.registerInstance(ICodeEditorService, codeEditors);
	using commands = new CommandService(services);
	services.registerInstance(ICommandService, commands);
	using opener = services.createInstance(OpenerService);
	opener.setDefaultExternalOpener({ openExternal: async url => { writes.push(url); return true; } });
	services.registerInstance(IOpenerService, opener);
	const url = `https://gitlab.example/team/project/-/commit/${selectedId}`;
	const element = historyElement({ remoteLinks: [{ name: 'origin', uri: URI.parse(url) }] });
	await commands.executeCommand('git.graph.copyHash', element);
	await commands.executeCommand('git.graph.copyMessage', element);
	await commands.executeCommand('git.graph.openRemote', element);
	assert.deepEqual(reads, [[selectedId, 'repo-selected']]);
	assert.deepEqual(writes, [selectedId, 'Selected\n\nThe complete body.', url]);
});

test('Graph creates branches and tags at the selected commit and preserves the repository during prompts', async () => {
	const requests: unknown[][] = [];
	let activeRepository = 'repo-selected';
	using services = new InstantiationService();
	registerGraphServices(services, {
		executeCommand: async (command, repositoryId) => { requests.push([command, repositoryId]); return { status: {} as GitStatus, outcome: 'completed', operation: undefined }; },
	});
	services.registerInstance(IQuickInputService, { input: async () => { activeRepository = 'repo-other'; return ' review '; } } as unknown as IQuickInputService);
	using commands = new CommandService(services);
	await commands.executeCommand('git.graph.createBranch', historyElement());
	await commands.executeCommand('git.graph.createTag', historyElement());
	await commands.executeCommand('git.graph.cherryPick', historyElement());
	assert.equal(activeRepository, 'repo-other');
	assert.deepEqual(requests, [
		[{ kind: 'createBranchAt', name: 'review', objectId: selectedId }, 'repo-selected'],
		[{ kind: 'createTag', name: 'review', reference: selectedId }, 'repo-selected'],
		[{ kind: 'cherryPick', reference: selectedId }, 'repo-selected'],
	]);
});

test('Graph cancellation never creates a branch, checks out a commit or opens a comparison', async () => {
	const requests: string[] = [];
	using services = new InstantiationService();
	registerGraphServices(services, {
		branches: async () => [], catalog: async () => ({ tags: [], stashes: [], remotes: [], operation: undefined }),
		executeCommand: async () => { requests.push('write'); throw new Error('unexpected mutation'); },
		compareChanges: async () => { requests.push('compare'); throw new Error('unexpected comparison'); },
	});
	services.registerInstance(IQuickInputService, inputSelecting(-1));
	services.registerInstance(IDialogService, { confirm: async () => ({ confirmed: false }) } as unknown as IDialogService);
	using commands = new CommandService(services);
	for (const kind of ['createBranch', 'checkoutDetached', 'compare']) { await commands.executeCommand(`git.graph.${kind}`, historyElement()); }
	assert.deepEqual(requests, []);
});

test('Graph reference actions switch the chosen branch and delete only the selected unoccupied local branch', async () => {
	const requests: unknown[][] = [];
	using services = new InstantiationService();
	registerGraphServices(services, {
		branches: async () => [
			{ name: 'main', objectId: selectedId, current: true, upstream: undefined },
			{ name: 'occupied', objectId: selectedId, current: false, checkedOutElsewhere: true, upstream: undefined },
			{ name: 'review', objectId: selectedId, current: false, checkedOutElsewhere: false, upstream: undefined },
		],
		switchBranch: async (...args) => { requests.push(['switch', ...args]); return {} as GitStatus; },
		deleteBranch: async (...args) => { requests.push(['delete', ...args]); },
	});
	services.registerInstance(IQuickInputService, inputSelecting(0));
	services.registerInstance(IDialogService, { confirm: async () => ({ confirmed: true }) } as unknown as IDialogService);
	using commands = new CommandService(services);
	const element = historyElement();
	const references = ['main', 'occupied', 'review'].map(name => ({ id: `localBranch:${name}`, name, category: 'localBranch' }));
	await commands.executeCommand('git.graph.checkoutBranch', { ...element, references: [references[2]] });
	await commands.executeCommand('git.graph.deleteBranch', { ...element, references });
	assert.deepEqual(requests, [['switch', 'review', 'repo-selected'], ['delete', 'review', 'repo-selected']]);
});

test('Graph merge cherry-pick asks for a parent and reports conflicts through the existing resolution workflow', async () => {
	const requests: GitCommand[] = [];
	const messages: string[] = [];
	using services = new InstantiationService();
	registerGraphServices(services, { executeCommand: async command => { requests.push(command); return { status: {} as GitStatus, outcome: 'conflicted', operation: 'cherryPick' }; } }, messages);
	services.registerInstance(IQuickInputService, inputSelecting(1));
	using commands = new CommandService(services);
	await commands.executeCommand('git.graph.cherryPick', historyElement({ parentIds: [firstParent, baseId] }));
	assert.deepEqual(requests, [{ kind: 'cherryPick', reference: selectedId, mainline: 2 }]);
	assert.match(messages[0], /Resolve the files in Source Control.*Git: Continue.*Git: Abort/);
});

for (const locale of ['en', 'zh-CN']) {
	test(`Graph branch creation describes its selected-commit behavior in ${locale}`, async () => {
		const prompts: string[] = [];
		const messages: string[] = [];
		const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale === locale)!;
		setNlsResolver((bundle, key, original, parameters) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? original, parameters));
		try {
			using services = new InstantiationService();
			registerGraphServices(services, { executeCommand: async () => ({ status: {} as GitStatus, outcome: 'completed', operation: undefined }) }, messages);
			services.registerInstance(IQuickInputService, inputSelecting(0, 'review', prompts));
			using commands = new CommandService(services);
			await commands.executeCommand('git.graph.createBranch', historyElement());
			assert.deepEqual(prompts, [locale === 'zh-CN' ? '分支名称（在所选提交处创建，不切换分支）' : 'Branch name (created at the selected commit without switching)']);
			assert.deepEqual(messages, [locale === 'zh-CN' ? 'Git 操作已完成。' : 'Git operation completed.']);
		} finally { resetNlsResolver(); }
	});
}

test('Graph comparisons keep each editor and file bound to its exact base and preserve graph pagination', async () => {
	const requests: unknown[][] = [];
	const opened: unknown[] = [];
	let graphReads = 0;
	const git: Partial<IGitService> = {
		onDidBecomeReady: Event.None, onDidChangeRepositoryStatus: Event.None,
		status: async () => ({ head: { type: 'branch', name: 'main', objectId: selectedId, upstream: undefined } } as GitStatus),
		branches: async () => [{ name: 'other', objectId: baseId, current: false, upstream: undefined }],
		catalog: async () => ({ tags: [], stashes: [], remotes: [], operation: undefined }),
		graph: async () => { graphReads++; return { commits: [{ objectId: selectedId, parentObjectIds: [firstParent], timestampSeconds: 1, subject: 'Selected', repositoryId: 'repo-selected' }], references: [], remotes: [], hasMore: false, nextCursor: undefined }; },
		compareChanges: async (...args) => { requests.push(['compare', ...args]); return { baseObjectId: baseId, changes: [{ path: 'new.ts', originalPath: 'old.ts', status: 'renamed' }] }; },
		commitChanges: async () => ({ parentObjectId: firstParent, changes: [{ path: 'new.ts', originalPath: undefined, status: 'modified' }] }),
		commitFile: async (...args) => { requests.push(['file', ...args]); return { original: { kind: 'text', text: args[3] ?? 'root' }, modified: { kind: 'text', text: 'selected contents' } }; },
	};
	using provider = new GitHistoryProvider(git as IGitService, 'repo-selected');
	await provider.provideHistoryItems({ limit: 1 });
	using services = new InstantiationService();
	registerGraphServices(services, git);
	services.registerInstance(IQuickInputService, inputSelecting(0));
	services.registerInstance(IEditorService, {
		openEditor: async (editor: IResourceEditorInput) => {
			assert.ok(isMultiDiffEditorInput(editor));
			opened.push({ resource: editor.resource.toString(), label: editor.label, original: editor.items[0].original.initialText, modified: editor.items[0].modified.initialText });
		}
	} as unknown as IEditorService);
	using commands = new CommandService(services);
	services.registerInstance(ICommandService, commands);
	const element = historyElement({}, provider);
	await commands.executeCommand('git.graph.compare', element);
	await commands.executeCommand('git.graph.compareMergeBase', element);
	await commands.executeCommand('git.graph.compareRemote', historyElement({ references: [{ id: 'localBranch:main', name: 'main', category: 'localBranch', upstream: 'origin/main' }] }, provider));
	await commands.executeCommand('workbench.scm.action.graph.viewChanges', element);
	assert.equal(graphReads, 1);
	assert.equal(opened.length, 4);
	assert.deepEqual(requests.filter(request => request[0] === 'file'), [
		['file', selectedId, 'new.ts', 'repo-selected', baseId],
		['file', selectedId, 'new.ts', 'repo-selected', baseId],
		['file', selectedId, 'new.ts', 'repo-selected', baseId],
		['file', selectedId, 'new.ts', 'repo-selected', firstParent],
	]);
	assert.ok(requests.some(request => request[0] === 'compare' && request[3] === 'mergeBase'));
	assert.ok(requests.some(request => request[0] === 'compare' && request[2] === 'refs/remotes/origin/main'));
	assert.deepEqual((opened as Array<{ original: string; modified: string; }>).map(editor => [editor.original, editor.modified]), [[baseId, 'selected contents'], [baseId, 'selected contents'], [baseId, 'selected contents'], [firstParent, 'selected contents']]);
	assert.notEqual((opened[0] as { resource: string; }).resource, (opened[3] as { resource: string; }).resource);
});
