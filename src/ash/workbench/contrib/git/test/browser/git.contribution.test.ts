import type { IResourceEditorInput } from '../../../../common/editor.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationError } from '../../../../../base/common/errors.js';
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
import { IQuickInputService, type IQuickPickItem, type IQuickPick } from '../../../../../platform/quickinput/common/quickInput.js';
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

function inputSelecting(index: number, inputValue?: string, prompts?: string[]): IQuickInputService {
	return {
		input: async options => { prompts?.push(options.placeHolder ?? ''); return inputValue; },
		createQuickPick: <T extends IQuickPickItem>() => {
			const accept = new Emitter<T>();
			const hide = new Emitter<void>();
			const picker = {
				items: [] as readonly T[],
				placeholder: '', ariaLabel: '',
				onDidAccept: accept.event, onDidHide: hide.event,
				show(): void { queueMicrotask(() => index < 0 ? hide.fire() : accept.fire(this.items[index])); },
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
