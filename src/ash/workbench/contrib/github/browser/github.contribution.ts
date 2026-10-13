import { URI } from '../../../../base/common/uri.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IAccountService } from '../../../../platform/accounts/common/accountService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import {
	GitHubError, GitHubErrorCode, GitHubIssueState, IGitHubService,
	type GitHubRepository,
} from '../../../../platform/github/common/githubService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { filterQuickPickItems } from '../../../../platform/quickinput/browser/quickInputList.js';
import { QuickAccessRegistry } from '../../../../platform/quickinput/common/quickAccess.js';
import { PickerQuickAccessProvider, type IPickerQuickAccessItem, type Picks } from '../../../../platform/quickinput/browser/pickerQuickAccess.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { localize, localize2 } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
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
import { readLocalRepositories } from '../common/localRepository.js';

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
		this._register(this.accounts.onDidChangeAccounts(() => {
			this.pageState = undefined;
			this.loadMoreRequested = false;
			this.refresh();
		}));
	}

	private readonly issues: boolean;
	private loadMoreRequested = false;
	private pageState: { query: string; matches: IPickerQuickAccessItem[]; remaining: { repository: GitHubRepository; page: number; }[]; } | undefined;

	protected override async _getPicks(query: string, _resources: DisposableStore, token: CancellationToken): Promise<Picks<IPickerQuickAccessItem>> {
		const issues = this.issues;
		const more = this.loadMoreRequested && this.pageState?.query === query;
		this.loadMoreRequested = false;
		const matches = more ? [...this.pageState!.matches] : [];
		const remaining: { repository: GitHubRepository; page: number; }[] = [];
		let targets = more ? this.pageState!.remaining : [];
		const accept = (run: () => Promise<unknown>): (() => void) => () => {
			void run().catch(error => this.notifications.error(localize('github.quickAccess.openFailed', 'Could not open the GitHub result: {0}', getErrorMessage(error))));
		};
		const openOverview = accept(() => this.editors.openEditor({
			resource: URI.parse('ash-github:/'),
			label: localize('github.editor.title', 'GitHub Pull Requests and Issues'),
			readOnly: true,
			showBreadcrumbs: false,
		}));
		try {
			if (!more) {
				const [accounts, checkouts] = await Promise.all([
					this.github.listAccounts(token),
					readLocalRepositories(this.commands),
				]);
				if (token.isCancellationRequested) return [];
				const repositories = new Map<string, GitHubRepository>();
				for (const checkout of checkouts) {
					for (const remote of checkout.remotes) {
						const identity = remote.identity;
						if (identity?.provider !== 'github') continue;
						const account = accounts.find(account => account.id === this.review.selectedAccount?.id
							&& account.host === identity.host && account.status === 'ready')
							?? accounts.find(account => account.host === identity.host && account.status === 'ready');
						if (!account) continue;
						const repository = { host: identity.host, accountId: account.id, owner: identity.owner, name: identity.repository };
						repositories.set(`${repository.host}/${repository.owner}/${repository.name}`.toLowerCase(), repository);
					}
				}
				// An explicitly selected review repository also works when no Git provider is installed.
				if (!repositories.size && this.review.repository) {
					const repository = this.review.repository;
					if (accounts.some(account => account.host === repository.host && account.status === 'ready'
						&& (!repository.accountId || account.id === repository.accountId))) {
						repositories.set(this.review.repositoryKey!, repository);
					}
				}
				if (!repositories.size) {
					return [{
						label: localize('github.quickAccess.chooseRepository', 'Open GitHub to sign in or choose a repository'),
						alwaysShow: true,
						accept: openOverview,
					}];
				}
				targets = [...repositories.values()].map(repository => ({ repository, page: 1 }));
			}
			const pages = await Promise.all(targets.map(async ({ repository, page }) => ({
				repository,
				result: issues
					? await this.github.listIssues(repository, GitHubIssueState.Open, query, page, token)
					: await this.github.listPullRequests(repository, GitHubIssueState.Open, page, token),
			})));
			if (token.isCancellationRequested) return [];
			for (const { repository, result } of pages) {
				if (result.nextPage !== null) remaining.push({ repository, page: result.nextPage });
				const picks = result.items.map(item => ({
					label: `#${item.number} ${item.title}`,
					description: `${repository.host}/${repository.owner}/${repository.name}`,
					accept: accept(() => this.editors.openEditor({
						resource: URI.from({
							scheme: 'ash-github', authority: repository.host,
							path: `/${repository.owner}/${repository.name}/${issues ? 'issues' : 'pull'}/${item.number}`,
							query: new URLSearchParams(repository.accountId ? { account: repository.accountId } : {}).toString(),
						}),
						label: `#${item.number} ${item.title}`,
						readOnly: true,
						showBreadcrumbs: false,
					})),
				}));
				matches.push(...(issues ? picks : filterQuickPickItems(picks, query)));
			}
			this.pageState = { query, matches, remaining };
			return [...matches, ...(remaining.length ? [{
				label: localize('github.quickAccess.loadMore', 'Load more results'), alwaysShow: true,
				keepOpen: true,
				accept: () => { this.loadMoreRequested = true; this.refresh(); },
			}] : [])];
		} catch (error) {
			if (token.isCancellationRequested) return [];
			return [{
				label: error instanceof GitHubError && error.code === GitHubErrorCode.AuthenticationRequired
					? localize('github.quickAccess.signIn', 'Sign in to GitHub to search issues and pull requests')
					: localize('github.quickAccess.failed', 'GitHub search failed. Open GitHub to reconnect or retry.'),
				alwaysShow: true, accept: openOverview,
			}];
		}
	}
}

for (const mode of [{ prefix: 'issue ', issues: true }, { prefix: 'pr ', issues: false }]) {
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
		get tabLabel() { return this.helpLabel; },
		tabOrder: mode.issues ? 2 : 3,
		ctor: new SyncDescriptor(GitHubQuickAccessProvider, [mode.prefix]),
	});
}

registerSingleton(IGitHubReviewModel, GitHubReviewModel, InstantiationType.Delayed);
registerEditorPane({
	id: githubEditorId, name: localize('github.editor.title', 'GitHub Pull Requests and Issues'),
	canOpen: input => input.resource.scheme === 'ash-github' ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => {
		if (!options.instantiationService) { throw new Error('GitHub editor requires Workbench services'); }
		return options.instantiationService.createInstance(GitHubEditor);
	},
});

registerAction2(class OpenGitHub extends Action2 {
	constructor() { super({ id: 'workbench.action.github.open', title: localize2('github.editor.title', 'GitHub Pull Requests and Issues'), f1: true }); }
	public override run(accessor: ServicesAccessor): Promise<unknown> {
		return accessor.get(IEditorService).openEditor({ resource: URI.parse('ash-github:/'), label: localize('github.editor.title', 'GitHub Pull Requests and Issues'), readOnly: true, showBreadcrumbs: false });
	}
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.GitHubEditor, defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('GitHub editor accessibility verbosity must be boolean'); } return value; },
	setting: { valueType: 'boolean', title: localize('github.editor.verbosity', 'GitHub editor accessibility help'), description: localize('github.editor.verbosityDescription', 'Announce how to open keyboard help in the GitHub editor.') },
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type, priority: 100, name: `githubEditor.${type}`, when: ActiveEditorContext.isEqualTo(githubEditorId),
		getProvider: accessor => {
			const pane = accessor.get(IEditorPart).activePane;
			if (!(pane instanceof GitHubEditor)) { return undefined; }
			const focused = pane.getControl().ownerDocument.activeElement;
			return new AccessibleContentProvider(AccessibleViewProviderId.GitHubEditor, { type },
				() => type === AccessibleViewType.Help ? localize('github.editor.help', 'Use Tab and Shift+Tab to move between repository fields, lists, diff editors and review actions. Use the arrow keys in the PR and issue list. Select a changed file and place the cursor on an original or modified diff line before adding a line comment. Add comments to the draft, then submit a review, approve or request changes. Drafts remain in this window when you close the tab. Refresh loads the latest commit; an older draft must be discarded before reviewing a changed PR. Checks and discussions have Load more actions. Merge asks you to confirm the reviewed commit. Alt+F1 opens this help; Escape closes it. Switching GitHub accounts clears private content and drafts. Choose an account in the header; Connect with token supports your Enterprise host. Reviewer actions request or remove users and teams. Your own review comments have edit and delete actions. Local repository actions choose the checkout and remote before checking out the reviewed commit or pushing local commits. Select Notifications and load to browse your account inbox; filter unread, all, or participating notifications, and use the read actions. The repository menu creates forks and starts Enterprise browser authorization. Notifications require OAuth App authorization or a classic token with notifications permission. Request Codex review posts @codex review as your GitHub account. Codex review settings opens the shared settings page for official Connector authorization and automatic review management. Refresh and Load more PR comments read the resulting conversation.') : pane.accessibleContent(),
				() => { if (focused instanceof HTMLElement && focused.isConnected) { focused.focus(); } else { pane.focus(); } }, AccessibilityVerbositySettingId.GitHubEditor);
		},
	});
}

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.GitHubSettings, defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('GitHub settings accessibility verbosity must be boolean'); } return value; },
	setting: { valueType: 'boolean', get title() { return localize('github.settings.verbosity', 'GitHub settings accessibility help'); }, get description() { return localize('github.settings.verbosityDescription', 'Announce how to open accessibility help in GitHub settings.'); } },
});
