import { IExtensionHostService } from '../../../services/extensionHost/common/extensionHostService.js';
import { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import { FileKind, IFileService } from '../../../../platform/files/common/files.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { extUri } from '../../../../base/common/resources.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import type { GitHubAccount, GitHubRemoteRepository, GitHubRepositoryVisibility } from '../../../../platform/github/common/githubService.js';
import { URI } from '../../../../base/common/uri.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { CancellationTokenSource, type CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IAccountService } from '../../../../platform/accounts/common/accountService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { GitHubError, GitHubErrorCode, GitHubIssueState, IGitHubService, type GitHubRepository } from '../../../../platform/github/common/githubService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { filterQuickPickItems } from '../../../../platform/quickinput/browser/quickInputList.js';
import { QuickAccessRegistry } from '../../../../platform/quickinput/common/quickAccess.js';
import { PickerQuickAccessProvider, type IPickerQuickAccessItem, type Picks } from '../../../../platform/quickinput/browser/pickerQuickAccess.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { localize, localize2 } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { ActiveEditorContext } from '../../../common/contextkeys.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { GitHubEditor, githubEditorId } from './githubEditor.js';
import { GitHubReviewModel, IGitHubReviewModel } from './githubReviewModel.js';
import { githubRemotes, isGitHubBranchProtected, type LocalRepository, readLocalRepositories } from '../common/localRepository.js';

/** Workspace repository search is transient; the GitHub editor keeps account and review state. */
class GitHubQuickAccessProvider extends PickerQuickAccessProvider<IPickerQuickAccessItem> {
	constructor(
		prefix: string,
		@IGitHubService private readonly github: IGitHubService,
		@ICommandService private readonly commands: ICommandService,
		@IAccountService private readonly accounts: IAccountService,
		@IGitHubReviewModel private readonly review: IGitHubReviewModel,
		@IEditorService private readonly editors: IEditorService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super(prefix, { debounce: 150 });
		this.issues = prefix === 'issue ';
		this._register(
			this.accounts.onDidChangeAccounts(() => {
				this.pageState = undefined;
				this.loadMoreRequested = false;
				this.refresh();
			}),
		);
	}

	private readonly issues: boolean;
	private loadMoreRequested = false;
	private pageState:
		| {
				query: string;
				matches: IPickerQuickAccessItem[];
				remaining: { repository: GitHubRepository; page: number }[];
		  }
		| undefined;

	protected override async _getPicks(query: string, _resources: DisposableStore, token: CancellationToken): Promise<Picks<IPickerQuickAccessItem>> {
		const issues = this.issues;
		const more = this.loadMoreRequested && this.pageState?.query === query;
		this.loadMoreRequested = false;
		const matches = more ? [...this.pageState!.matches] : [];
		const remaining: { repository: GitHubRepository; page: number }[] = [];
		let targets = more ? this.pageState!.remaining : [];
		const accept =
			(run: () => Promise<unknown>): (() => void) =>
			() => {
				void run().catch(error => this.notifications.error(localize('github.quickAccess.openFailed', 'Could not open the GitHub result: {0}', getErrorMessage(error))));
			};
		const openOverview = accept(() =>
			this.editors.openEditor({
				resource: URI.parse('ash-github:/'),
				label: localize('github.editor.title', 'GitHub Pull Requests and Issues'),
				readOnly: true,
				showBreadcrumbs: false,
			}),
		);
		try {
			if (!more) {
				const [accounts, checkouts] = await Promise.all([this.github.listAccounts(token), readLocalRepositories(this.commands)]);
				if (token.isCancellationRequested) return [];
				const repositories = new Map<string, GitHubRepository>();
				for (const checkout of checkouts) {
					for (const remote of checkout.remotes) {
						const identity = remote.identity;
						if (identity?.provider !== 'github') continue;
						const account =
							accounts.find(account => account.id === this.review.selectedAccount?.id && account.host === identity.host && account.status === 'ready') ??
							accounts.find(account => account.host === identity.host && account.status === 'ready');
						if (!account) continue;
						const repository = {
							host: identity.host,
							accountId: account.id,
							owner: identity.owner,
							name: identity.repository,
						};
						repositories.set(`${repository.host}/${repository.owner}/${repository.name}`.toLowerCase(), repository);
					}
				}
				// An explicitly selected review repository also works when no Git provider is installed.
				if (!repositories.size && this.review.repository) {
					const repository = this.review.repository;
					if (accounts.some(account => account.host === repository.host && account.status === 'ready' && (!repository.accountId || account.id === repository.accountId))) {
						repositories.set(this.review.repositoryKey!, repository);
					}
				}
				if (!repositories.size) {
					return [
						{
							label: localize('github.quickAccess.chooseRepository', 'Open GitHub to sign in or choose a repository'),
							alwaysShow: true,
							accept: openOverview,
						},
					];
				}
				targets = [...repositories.values()].map(repository => ({ repository, page: 1 }));
			}
			const pages = await Promise.all(
				targets.map(async ({ repository, page }) => ({
					repository,
					result: issues
						? await this.github.listIssues(repository, GitHubIssueState.Open, query, page, token)
						: await this.github.listPullRequests(repository, GitHubIssueState.Open, page, token),
				})),
			);
			if (token.isCancellationRequested) return [];
			for (const { repository, result } of pages) {
				if (result.nextPage !== null) remaining.push({ repository, page: result.nextPage });
				const picks = result.items.map(item => ({
					label: `#${item.number} ${item.title}`,
					description: `${repository.host}/${repository.owner}/${repository.name}`,
					accept: accept(() =>
						this.editors.openEditor({
							resource: URI.from({
								scheme: 'ash-github',
								authority: repository.host,
								path: `/${repository.owner}/${repository.name}/${issues ? 'issues' : 'pull'}/${item.number}`,
								query: new URLSearchParams(repository.accountId ? { account: repository.accountId } : {}).toString(),
							}),
							label: `#${item.number} ${item.title}`,
							readOnly: true,
							showBreadcrumbs: false,
						}),
					),
				}));
				matches.push(...(issues ? picks : filterQuickPickItems(picks, query)));
			}
			this.pageState = { query, matches, remaining };
			return [
				...matches,
				...(remaining.length
					? [
							{
								label: localize('github.quickAccess.loadMore', 'Load more results'),
								alwaysShow: true,
								keepOpen: true,
								accept: () => {
									this.loadMoreRequested = true;
									this.refresh();
								},
							},
						]
					: []),
			];
		} catch (error) {
			if (token.isCancellationRequested) return [];
			return [
				{
					label:
						error instanceof GitHubError && error.code === GitHubErrorCode.AuthenticationRequired
							? localize('github.quickAccess.signIn', 'Sign in to GitHub to search issues and pull requests')
							: localize('github.quickAccess.failed', 'GitHub search failed. Open GitHub to reconnect or retry.'),
					alwaysShow: true,
					accept: openOverview,
				},
			];
		}
	}
}

for (const mode of [
	{ prefix: 'issue ', issues: true },
	{ prefix: 'pr ', issues: false },
]) {
	QuickAccessRegistry.register({
		prefix: mode.prefix,
		get placeholder() {
			return mode.issues
				? localize('github.quickAccess.issuePlaceholder', 'Search open GitHub issues by title or number')
				: localize('github.quickAccess.prPlaceholder', 'Search open GitHub pull requests by title or number');
		},
		get helpLabel() {
			return mode.issues ? localize('github.quickAccess.issuesTab', 'Issues') : localize('github.quickAccess.prTab', 'PR');
		},
		get tabLabel() {
			return this.helpLabel;
		},
		tabOrder: mode.issues ? 2 : 3,
		ctor: new SyncDescriptor(GitHubQuickAccessProvider, [mode.prefix]),
	});
}

registerSingleton(IGitHubReviewModel, GitHubReviewModel, InstantiationType.Delayed);
registerEditorPane({
	id: githubEditorId,
	name: localize('github.editor.title', 'GitHub Pull Requests and Issues'),
	canOpen: input => (input.resource.scheme === 'ash-github' ? EditorPaneMatch.Default : EditorPaneMatch.None),
	create: options => {
		if (!options.instantiationService) {
			throw new Error('GitHub editor requires Workbench services');
		}
		return options.instantiationService.createInstance(GitHubEditor);
	},
});

registerAction2(
	class OpenGitHub extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.github.open',
				title: localize2('github.editor.title', 'GitHub Pull Requests and Issues'),
				f1: true,
			});
		}
		public override run(accessor: ServicesAccessor): Promise<unknown> {
			return accessor.get(IEditorService).openEditor({
				resource: URI.parse('ash-github:/'),
				label: localize('github.editor.title', 'GitHub Pull Requests and Issues'),
				readOnly: true,
				showBreadcrumbs: false,
			});
		}
	},
);

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.GitHubEditor,
	defaultValue: true,
	parse: value => {
		if (typeof value !== 'boolean') {
			throw new TypeError('GitHub editor accessibility verbosity must be boolean');
		}
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('github.editor.verbosity', 'GitHub editor accessibility help'),
		description: localize('github.editor.verbosityDescription', 'Announce how to open keyboard help in the GitHub editor.'),
	},
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type,
		priority: 100,
		name: `githubEditor.${type}`,
		when: ActiveEditorContext.isEqualTo(githubEditorId),
		getProvider: accessor => {
			const pane = accessor.get(IEditorPart).activePane;
			if (!(pane instanceof GitHubEditor)) {
				return undefined;
			}
			const focused = pane.getControl().ownerDocument.activeElement;
			return new AccessibleContentProvider(
				AccessibleViewProviderId.GitHubEditor,
				{ type },
				() =>
					type === AccessibleViewType.Help
						? localize(
								'github.editor.help',
								'Use Tab and Shift+Tab to move between repository fields, lists, diff editors and review actions. Use the arrow keys in the PR and issue list. Select a changed file and place the cursor on an original or modified diff line before adding a line comment. Add comments to the draft, then submit a review, approve or request changes. Drafts remain in this window when you close the tab. Refresh loads the latest commit; an older draft must be discarded before reviewing a changed PR. Checks and discussions have Load more actions. Merge asks you to confirm the reviewed commit. Alt+F1 opens this help; Escape closes it. Switching GitHub accounts clears private content and drafts. Choose an account in the header; Connect with token supports your Enterprise host. Reviewer actions request or remove users and teams. Your own review comments have edit and delete actions. Local repository actions choose the checkout and remote before checking out the reviewed commit or pushing local commits. Select Notifications and load to browse your account inbox; filter unread, all, or participating notifications, and use the read actions. The repository menu creates forks and starts Enterprise browser authorization. Notifications require OAuth App authorization or a classic token with notifications permission. Request Codex review posts @codex review as your GitHub account. Codex review settings opens the shared settings page for official Connector authorization and automatic review management. Refresh and Load more PR comments read the resulting conversation.',
							) +
							'\n' +
							localize(
								'github.repository.help',
								'Use the Command Palette to publish or clone a GitHub repository. Repository search accepts names, owner/name or a URL. Use arrow keys to select a result, Enter to accept or load more, and Escape to cancel. The Share menus copy GitHub or vscode.dev links. Publishing asks you to confirm the account, visibility and branch; protected branches use the normal Git commit prompt.',
							)
						: pane.accessibleContent(),
				() => {
					if (focused instanceof HTMLElement && focused.isConnected) {
						focused.focus();
					} else {
						pane.focus();
					}
				},
				AccessibilityVerbositySettingId.GitHubEditor,
			);
		},
	});
}

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.GitHubSettings,
	defaultValue: true,
	parse: value => {
		if (typeof value !== 'boolean') {
			throw new TypeError('GitHub settings accessibility verbosity must be boolean');
		}
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() {
			return localize('github.settings.verbosity', 'GitHub settings accessibility help');
		},
		get description() {
			return localize('github.settings.verbosityDescription', 'Announce how to open accessibility help in GitHub settings.');
		},
	},
});

// These are window interactions. Repository API policy remains in the profile-scoped Rust provider.
async function githubPick<T>(quick: IQuickInputService, title: string, values: readonly { label: string; description?: string; detail?: string; value: T }[]): Promise<T | undefined> {
	const resources = new DisposableStore();
	const picker = resources.add(quick.createQuickPick<IQuickPickItem & { value: T }>());
	picker.placeholder = title;
	picker.ariaLabel = title;
	picker.items = values;
	return new Promise(resolve => {
		resources.add(
			picker.onDidHide(() => {
				resolve(undefined);
				resources.dispose();
			}),
		);
		resources.add(
			picker.onDidAccept(() => {
				const item = picker.activeItems[0];
				if (item) {
					resolve(item.value);
					picker.hide();
				}
			}),
		);
		picker.show();
	});
}

async function githubAccount(github: IGitHubService, quick: IQuickInputService, commands: ICommandService): Promise<GitHubAccount | undefined> {
	const accounts = (await github.listAccounts()).filter(account => account.status === 'ready');
	if (!accounts.length) {
		await commands.executeCommand('workbench.action.github.open');
		throw new Error(localize('github.repository.signIn', 'Sign in to GitHub before searching or publishing repositories.'));
	}
	if (accounts.length === 1) return accounts[0];
	return githubPick(
		quick,
		localize('github.repository.account', 'Choose a GitHub account'),
		accounts.map(account => ({ label: account.login, description: account.host, value: account })),
	);
}

/** Each query owns its cancellation source; obsolete replies never replace visible results. */
async function githubRemote(github: IGitHubService, quick: IQuickInputService, accounts: IAccountService, account: GitHubAccount): Promise<GitHubRemoteRepository | undefined> {
	const resources = new DisposableStore();
	type RemotePick = IQuickPickItem & ({ repository: GitHubRemoteRepository } | { page: number });
	const picker = resources.add(quick.createQuickPick<RemotePick>());
	picker.placeholder = localize('github.repository.search', 'Search GitHub repositories or paste a repository URL');
	picker.ariaLabel = picker.placeholder;
	picker.sortByLabel = false;
	// The server owns search ranking. Quick Pick must not filter qualified queries or URLs again.
	picker.filterValue = () => '';
	let pending: CancellationTokenSource | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	const search = async (query: string, page: number): Promise<void> => {
		pending?.cancel();
		pending?.dispose();
		const source = (pending = new CancellationTokenSource());
		picker.busy = true;
		try {
			const result = await github.searchRepositories(account.id, query, page, source.token);
			if (disposed || source.token.isCancellationRequested) return;
			const previous = page === 1 ? [] : picker.items.filter((item): item is RemotePick => 'repository' in item);
			const seen = new Set(previous.map(item => ('repository' in item ? item.repository.htmlUrl : '')));
			picker.items = [
				...previous,
				...result.items
					.filter(row => !seen.has(row.htmlUrl))
					.map(row => ({
						label: `${row.repository.owner}/${row.repository.name}`,
						description: row.private ? localize('github.repository.private', 'Private') : localize('github.repository.stars', '{0} stars', row.stars),
						detail: row.description ?? undefined,
						repository: row,
					})),
				...(result.nextPage === null
					? []
					: [
							{
								label: localize('github.repository.more', 'Load more repositories'),
								page: result.nextPage,
								alwaysShow: true,
							},
						]),
			];
		} catch (error) {
			if (!disposed && !source.token.isCancellationRequested) {
				picker.items = [
					{
						label: localize('github.repository.retry', 'Search failed. Press Enter to retry.'),
						detail: getErrorMessage(error),
						page,
						alwaysShow: true,
					},
				];
			}
		} finally {
			if (!disposed && pending === source) picker.busy = false;
		}
	};
	return new Promise(resolve => {
		resources.add(
			picker.onDidChangeValue(query => {
				clearTimeout(timer);
				pending?.cancel();
				picker.items = [];
				timer = setTimeout(() => {
					void search(query, 1);
				}, 200);
			}),
		);
		resources.add(
			picker.onDidAccept(() => {
				const item = picker.activeItems[0];
				if (!item) return;
				if ('page' in item) {
					void search(picker.value, item.page);
					return;
				}
				resolve(item.repository);
				picker.hide();
			}),
		);
		resources.add(
			picker.onDidHide(() => {
				disposed = true;
				clearTimeout(timer);
				pending?.cancel();
				pending?.dispose();
				resolve(undefined);
				resources.dispose();
			}),
		);
		resources.add(accounts.onDidChangeAccounts(() => picker.hide()));
		picker.show();
		void search('', 1);
	});
}

/** Branch pages load only on request, and closing the picker cancels its in-flight read. */
async function githubBranch(github: IGitHubService, quick: IQuickInputService, accounts: IAccountService, remote: GitHubRemoteRepository): Promise<{ readonly name?: string } | undefined> {
	const resources = new DisposableStore();
	const source = new CancellationTokenSource();
	type BranchPick = IQuickPickItem & ({ name: string } | { page: number });
	const picker = resources.add(quick.createQuickPick<BranchPick>());
	picker.ariaLabel = picker.placeholder = localize('github.repository.branch', 'Choose a branch to clone');
	picker.sortByLabel = false;
	const branches = new Map<string, BranchPick>();
	let disposed = false;
	let resolveSelection!: (value: { readonly name?: string } | undefined) => void;
	const selection = new Promise<{ readonly name?: string } | undefined>(resolve => {
		resolveSelection = resolve;
	});
	const load = async (page: number): Promise<void> => {
		picker.busy = true;
		try {
			const result = await github.listRepositoryBranches(remote.repository, page, source.token);
			if (disposed) return;
			for (const branch of result.items) branches.set(branch.name, { label: branch.name, name: branch.name });
			if (!branches.size && result.nextPage === null) {
				resolveSelection({});
				picker.hide();
				return;
			}
			const picks = [...branches.values()].sort((a, b) => Number('name' in b && b.name === remote.defaultBranch) - Number('name' in a && a.name === remote.defaultBranch));
			picker.items = [
				...picks,
				...(result.nextPage === null
					? []
					: [
							{
								label: localize('github.repository.moreBranches', 'Load more branches'),
								page: result.nextPage,
								alwaysShow: true,
							},
						]),
			];
		} catch (error) {
			if (!disposed)
				picker.items = [
					{
						label: localize('github.repository.retryBranches', 'Could not load branches. Press Enter to retry.'),
						detail: getErrorMessage(error),
						page,
						alwaysShow: true,
					},
				];
		} finally {
			if (!disposed) picker.busy = false;
		}
	};
	resources.add(
		picker.onDidAccept(() => {
			if (picker.busy) return;
			const item = picker.activeItems[0];
			if (!item) return;
			if ('page' in item) {
				void load(item.page);
				return;
			}
			resolveSelection({ name: item.name });
			picker.hide();
		}),
	);
	resources.add(
		picker.onDidHide(() => {
			disposed = true;
			source.cancel();
			source.dispose();
			resolveSelection(undefined);
			resources.dispose();
		}),
	);
	resources.add(accounts.onDidChangeAccounts(() => picker.hide()));
	picker.show();
	void load(1);
	return selection;
}

registerAction2(
	class CloneGitHubRepository extends Action2 {
		constructor() {
			super({
				id: 'github.clone',
				title: localize2('github.repository.clone', 'GitHub: Clone Repository'),
				f1: true,
			});
		}
		override async run(accessor: ServicesAccessor): Promise<void> {
			const gitHost = accessor.get(IExtensionHostService);
			const extensions = accessor.get(IExtensionService);
			const github = accessor.get(IGitHubService);
			const quick = accessor.get(IQuickInputService);
			const commands = accessor.get(ICommandService);
			const configuration = accessor.get(IConfigurationService);
			const accounts = accessor.get(IAccountService);
			await gitHost.start();
			await extensions.activateByEvent('onCommand:git.clone');
			const account = await githubAccount(github, quick, commands);
			if (!account) return;
			const remote = await githubRemote(github, quick, accounts, account);
			if (!remote) return;
			const branch = await githubBranch(github, quick, accounts, remote);
			if (!branch) return;
			const ssh = configuration.getValue<string>('github.gitProtocol') === 'ssh';
			await commands.executeCommand('git.clone', ssh ? remote.sshUrl : remote.cloneUrl, branch.name ?? null, account.id);
		}
	},
);

async function githubCheckout(commands: ICommandService, dialogs: IDialogService, quick: IQuickInputService): Promise<LocalRepository | undefined> {
	let repositories = await readLocalRepositories(commands);
	if (!repositories.length) {
		if (
			!(
				await dialogs.confirm({
					message: localize('github.publish.initialize', 'Initialize a Git repository in a workspace folder before publishing?'),
				})
			).confirmed
		)
			return;
		await commands.executeCommand('git.init');
		repositories = await readLocalRepositories(commands);
	}
	if (repositories.length === 1) return repositories[0];
	return githubPick(
		quick,
		localize('github.publish.checkout', 'Choose a local repository to publish'),
		repositories.map(repository => ({
			label: repository.label,
			description: repository.root.fsPath,
			value: repository,
		})),
	);
}

registerAction2(
	class PublishGitHubRepository extends Action2 {
		constructor() {
			super({
				id: 'github.publish',
				title: localize2('github.publish.title', 'GitHub: Publish Repository'),
				f1: true,
			});
		}
		override async run(accessor: ServicesAccessor): Promise<void> {
			const gitHost = accessor.get(IExtensionHostService);
			const extensions = accessor.get(IExtensionService);
			const github = accessor.get(IGitHubService);
			const quick = accessor.get(IQuickInputService);
			const commands = accessor.get(ICommandService);
			const dialogs = accessor.get(IDialogService);
			const configuration = accessor.get(IConfigurationService);
			const notifications = accessor.get(INotificationService);
			await gitHost.start();
			await extensions.activateByEvent('onCommand:git.getRepositoryContexts');
			const account = await githubAccount(github, quick, commands);
			if (!account) return;
			let checkout = await githubCheckout(commands, dialogs, quick);
			if (!checkout) return;
			if (!checkout.head.objectId) {
				if (
					!(
						await dialogs.confirm({
							message: localize('github.publish.firstCommit', 'Create the first commit before publishing?'),
							detail: localize('github.publish.reviewFiles', 'Review ignored files and choose which files to include in the Git commit dialog.'),
						})
					).confirmed
				)
					return;
				await commands.executeCommand('git.commitFromChanges', checkout.id);
				checkout = (await readLocalRepositories(commands)).find(repository => repository.id === checkout!.id);
				if (!checkout?.head.objectId) return;
			}
			if (checkout.head.type !== 'branch' || !checkout.head.name) throw new Error(localize('github.publish.branchRequired', 'Check out a local branch before publishing.'));
			const name = await quick.input({
				title: localize('github.publish.name', 'GitHub repository name'),
				value: checkout.label.replace(/[^a-zA-Z0-9_.-]/g, '-'),
				validateInput: async value =>
					/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,99}$/.test(value)
						? undefined
						: localize('github.publish.invalidName', 'Use 1–100 letters, digits, underscores, periods or hyphens. Start with a letter, digit or underscore.'),
			});
			if (!name) return;
			const visibility = await githubPick<GitHubRepositoryVisibility>(quick, localize('github.publish.visibility', 'Choose repository visibility'), [
				{ label: localize('github.publish.private', 'Publish private repository'), value: 'private' },
				{ label: localize('github.publish.public', 'Publish public repository'), value: 'public' },
			]);
			if (!visibility) return;
			let remoteName = 'origin';
			if (checkout.remotes.some(remote => remote.name === remoteName)) {
				const chosen = await quick.input({
					title: localize('github.publish.remote', 'Remote name (origin already exists)'),
					value: 'github',
					validateInput: async value =>
						/^[a-zA-Z0-9_-]+$/.test(value) && !checkout!.remotes.some(remote => remote.name === value)
							? undefined
							: localize('github.publish.remoteInvalid', 'Choose a new remote name using letters, digits, underscores or hyphens.'),
				});
				if (!chosen) return;
				remoteName = chosen;
			}
			const uncommitted = checkout.uncommittedChanges ?? 0;
			if (
				!(
					await dialogs.confirm({
						message:
							visibility === 'private'
								? localize('github.publish.confirmPrivate', 'Publish {0}/{1} as a private repository on {2}?', account.login, name, account.host)
								: localize('github.publish.confirmPublic', 'Publish {0}/{1} as a public repository on {2}?', account.login, name, account.host),
						detail: localize(
							'github.publish.confirmDetail',
							'Only committed history on branch {0} will be pushed from {1}. Uncommitted files: {2}. Review the history for secrets before publishing.',
							checkout.head.name,
							checkout.root.fsPath,
							uncommitted,
						),
						primaryButton: localize('github.publish.button', 'Publish'),
					})
				).confirmed
			)
				return;
			let created: GitHubRemoteRepository;
			try {
				created = await github.createRepository(account.id, name, '', visibility);
			} catch (error) {
				if (error instanceof GitHubError && error.code === GitHubErrorCode.SubmissionUncertain)
					throw new Error(localize('github.publish.uncertain', 'Repository creation may have succeeded. Check https://{0}/{1}/{2} before retrying.', account.host, account.login, name));
				throw error;
			}
			// The remote write is complete. Failure below must never cause repository creation to replay.
			try {
				const ssh = configuration.getValue<string>('github.gitProtocol') === 'ssh';
				await commands.executeCommand('git.executeRepositoryCommand', checkout.id, { kind: 'addRemote', name: remoteName, url: ssh ? created.sshUrl : created.cloneUrl }, account.id);
				await commands.executeCommand(
					'git.executeRepositoryCommand',
					checkout.id,
					{
						kind: 'publishBranch',
						remote: remoteName,
						name: checkout.head.name,
						branch: checkout.head.name,
						expectedHead: checkout.head.objectId,
					},
					account.id,
				);
				notifications.info(localize('github.publish.done', 'Published repository: {0}', created.htmlUrl));
			} catch (error) {
				throw new Error(
					localize(
						'github.publish.pushFailed',
						'The repository was created at {0}, but publishing the local branch failed: {1}. Add or inspect remote {2}, then retry Git: Publish Branch. Do not create the repository again.',
						created.htmlUrl,
						getErrorMessage(error),
						remoteName,
					),
				);
			}
		}
	},
);

for (const action of [
	{
		id: 'github.copyVscodeDevLink',
		title: localize2('github.share.dev', 'Copy vscode.dev Link'),
		target: 'vscodeDev' as const,
		permalink: false,
		open: false,
	},
	{
		id: 'github.copyVscodeDevLinkFile',
		title: localize2('github.share.dev', 'Copy vscode.dev Link'),
		target: 'vscodeDev' as const,
		permalink: false,
		open: false,
	},
	{
		id: 'github.copyVscodeDevLinkWithoutRange',
		title: localize2('github.share.dev', 'Copy vscode.dev Link'),
		target: 'vscodeDev' as const,
		permalink: false,
		open: false,
	},
	{
		id: 'github.copyPermalink',
		title: localize2('github.share.permalink', 'Copy GitHub Permalink'),
		target: 'gitHub' as const,
		permalink: true,
		open: false,
	},
	{
		id: 'github.openOnGitHub',
		title: localize2('github.share.open', 'Open on GitHub'),
		target: 'gitHub' as const,
		permalink: false,
		open: true,
	},
]) {
	const withoutRange = ['github.copyVscodeDevLinkFile', 'github.copyVscodeDevLinkWithoutRange'].includes(action.id);
	const menu =
		action.id === 'github.copyVscodeDevLinkFile'
			? [{ id: MenuId.ExplorerContextShare, group: 'github' }]
			: action.id === 'github.copyVscodeDevLinkWithoutRange'
				? [{ id: MenuId.EditorTitleContext, group: 'github' }]
				: [{ id: MenuId.EditorContextShare, group: 'github' }, ...(action.id === 'github.copyVscodeDevLink' ? [] : [{ id: MenuId.ExplorerContextShare, group: 'github' }])];
	registerAction2(
		class GitHubShareAction extends Action2 {
			constructor() {
				super({ id: action.id, title: action.title, f1: !withoutRange, menu });
			}
			override async run(accessor: ServicesAccessor, argument?: unknown): Promise<void> {
				const gitHost = accessor.get(IExtensionHostService);
				const extensions = accessor.get(IExtensionService);
				const commands = accessor.get(ICommandService);
				const quick = accessor.get(IQuickInputService);
				const dialogs = accessor.get(IDialogService);
				const github = accessor.get(IGitHubService);
				const workingCopies = accessor.get(IWorkingCopyService);
				const files = accessor.get(IFileService);
				const clipboard = accessor.get(IClipboardService);
				const opener = accessor.get(IOpenerService);
				const notifications = accessor.get(INotificationService);
				const editor = accessor.get(ICodeEditorService).getFocusedCodeEditor() ?? accessor.get(ICodeEditorService).getActiveCodeEditor();
				const resource = argument instanceof URI ? argument : accessor.get(IEditorService).activeEditor?.resource;
				await gitHost.start();
				await extensions.activateByEvent('onCommand:git.getRepositoryContexts');
				const repositories = await readLocalRepositories(commands);
				let checkout = resource
					? repositories.filter(repository => extUri.isEqualOrParent(resource, repository.root)).sort((a, b) => b.root.path.length - a.root.path.length)[0]
					: await githubPick(
							quick,
							localize('github.share.checkout', 'Choose a repository to share'),
							repositories.map(repository => ({
								label: repository.label,
								description: repository.root.fsPath,
								value: repository,
							})),
						);
				if (!checkout) throw new Error(localize('github.share.noCheckout', 'Open a file in a Git repository to share a link.'));
				const remotes = githubRemotes(checkout);
				if (!remotes.length) {
					if (
						(
							await dialogs.confirm({
								message: localize('github.share.publish', 'Publish this repository on GitHub before sharing?'),
							})
						).confirmed
					)
						await commands.executeCommand('github.publish');
					return;
				}
				const remote =
					remotes.length === 1 || checkout.head.upstream?.name.startsWith(`${remotes[0]!.name}/`)
						? remotes[0]
						: await githubPick(
								quick,
								localize('github.share.remote', 'Choose a GitHub remote'),
								remotes.map(remote => ({
									label: remote.name,
									description: `${remote.identity!.host}/${remote.identity!.owner}/${remote.identity!.repository}`,
									value: remote,
								})),
							);
				if (!remote?.identity) return;
				if (checkout.head.type === 'branch' && !checkout.head.upstream?.name.startsWith(`${remote.name}/`)) {
					if (
						!(
							await dialogs.confirm({
								message: localize('github.share.publishBranch', 'Publish the current branch before sharing?'),
							})
						).confirmed
					)
						return;
					await commands.executeCommand('git.executeRepositoryCommand', checkout.id, {
						kind: 'publishBranch',
						remote: remote.name,
						name: checkout.head.name,
						branch: checkout.head.name,
						expectedHead: checkout.head.objectId,
					});
				} else if ((checkout.head.upstream?.ahead ?? 0) > 0) {
					if (
						!(
							await dialogs.confirm({
								message: localize('github.share.push', 'Push local commits before sharing?'),
							})
						).confirmed
					)
						return;
					await commands.executeCommand('git.push', checkout.id);
				}
				checkout = (await readLocalRepositories(commands)).find(repository => repository.id === checkout!.id);
				if (checkout?.head.upstream && checkout.head.upstream.behind > 0 && !action.permalink) {
					if (
						!(
							await dialogs.confirm({
								message: localize('github.share.pull', 'Pull remote commits before sharing a link to the branch?'),
							})
						).confirmed
					)
						return;
					await commands.executeCommand('git.pull', checkout.id);
					checkout = (await readLocalRepositories(commands)).find(repository => repository.id === checkout!.id);
					if (checkout?.head.upstream && checkout.head.upstream.behind > 0)
						throw new Error(localize('github.share.behind', 'The local branch is still behind the remote. Pull the latest changes before sharing.'));
				}
				if (!checkout) return;
				if (!checkout.head.objectId) throw new Error(localize('github.share.commitRequired', 'Create and publish a commit before sharing a link.'));
				if (checkout.head.type === 'branch' && (!checkout.head.upstream?.name.startsWith(`${remote.name}/`) || checkout.head.upstream.ahead > 0))
					throw new Error(localize('github.share.unpublished', 'The branch still has unpublished commits. Publish or push it before sharing.'));
				if ((checkout.uncommittedChanges ?? 0) > 0 || (resource && workingCopies.get(resource).some(copy => copy.isDirty))) {
					if (
						!(
							await dialogs.confirm({
								message: localize('github.share.dirty', 'Copy a link to the committed version?'),
								detail: localize('github.share.dirtyDetail', 'Local changes are not included. Line numbers may differ from the published file.'),
								primaryButton: localize('github.share.copyAnyway', 'Continue'),
							})
						).confirmed
					)
						return;
				}
				const file = resource && resource.path !== checkout.root.path ? resource.path.slice(checkout.root.path.replace(/\/$/, '').length + 1) : undefined;
				const directory = resource ? (await files.stat(resource)).kind === FileKind.Directory : false;
				const selection = !withoutRange && !directory && resource && editor?.getModel()?.uri.toString() === resource.toString() ? editor.getSelection() : undefined;
				const url = await github.shareLink({
					repository: {
						host: remote.identity.host,
						owner: remote.identity.owner,
						name: remote.identity.repository,
					},
					reference: action.permalink || checkout.head.type !== 'branch' ? checkout.head.objectId : checkout.head.upstream!.name.slice(remote.name.length + 1),
					referenceKind: action.permalink || checkout.head.type !== 'branch' ? 'commit' : 'branch',
					target: action.target,
					...(file ? { path: file, pathKind: directory ? ('directory' as const) : ('file' as const) } : {}),
					...(file && selection
						? {
								lines: {
									start: selection.startLineNumber,
									end: selection.endLineNumber - (selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? 1 : 0),
								},
							}
						: {}),
				});
				if (action.open) await opener.open(url, { openExternal: true });
				else {
					await clipboard.writeText(url);
					notifications.info(localize('github.share.copied', 'Link copied to clipboard.'));
				}
			}
		},
	);
}

// Optional provider hook used by the Git extension immediately before its normal commit guard.
CommandsRegistry.register('github.isBranchProtected', async (accessor, branch: unknown, remotes: unknown) => {
	if (typeof branch !== 'string' || !Array.isArray(remotes) || remotes.length > 128) throw new TypeError('Invalid branch protection request');
	if (accessor.get(IConfigurationService).getValue<boolean>('github.branchProtection') === false) return false;
	const github = accessor.get(IGitHubService);
	const accounts = await github.listAccounts();
	for (const remote of remotes) {
		const identity = remote?.identity;
		if (identity?.provider !== 'github') continue;
		if (typeof identity.host !== 'string' || typeof identity.owner !== 'string' || typeof identity.repository !== 'string') throw new TypeError('Invalid GitHub remote identity');
		const account = accounts.find(account => account.host === identity.host && account.status === 'ready');
		if (!account) continue;
		if (
			isGitHubBranchProtected(
				branch,
				await github.readBranchProtection({
					host: identity.host,
					owner: identity.owner,
					name: identity.repository,
					accountId: account.id,
				}),
			)
		)
			return true;
	}
	return false;
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'github.branchProtection',
	defaultValue: true,
	parse: value => {
		if (typeof value !== 'boolean') throw new TypeError('Invalid GitHub branch protection setting');
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('github.protection.setting', 'GitHub branch protection'),
		description: localize('github.protection.description', 'Check active GitHub rulesets before committing to a protected branch.'),
	},
});
Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'github.gitProtocol',
	defaultValue: 'https',
	parse: value => {
		if (value !== 'https' && value !== 'ssh') throw new TypeError('Invalid GitHub Git protocol');
		return value;
	},
	setting: {
		valueType: 'select',
		title: localize('github.protocol.setting', 'GitHub Git protocol'),
		description: localize('github.protocol.description', 'Protocol used when cloning or publishing GitHub repositories.'),
		options: [
			{ value: 'https', label: 'HTTPS' },
			{ value: 'ssh', label: 'SSH' },
		],
	},
});
