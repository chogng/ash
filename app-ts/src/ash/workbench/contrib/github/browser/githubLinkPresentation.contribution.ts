import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IAccountService } from '../../../../platform/accounts/common/accountService.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ILinkPresentationService, type ILinkPresentation, type ILinkPresentationProvider, type ILinkPresentationWatcher, type LinkPresentationKind } from '../../../../platform/dataChannel/common/dataChannel.js';
import { GitHubError, GitHubErrorCode, IGitHubService } from '../../../../platform/github/common/githubService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IGitHubConnectionService } from '../../../services/accounts/common/gitHubConnectionService.js';
import { GitHubCommitResolver, type IGitHubCommitTarget } from './githubCommitResolver.js';
import { computePullRequestIcon } from '../../../common/chatPullRequest.js';
import { createCommitResourceHover, createIssueResourceHover, createPullRequestResourceHover, createRepositoryResourceHover, getIssueResourceStatus, getPullRequestChecksStatus, getPullRequestChecksStatusLabel, getPullRequestResourceStatus, GitHubResourcePresentation } from './githubResourceHover.js';
import { LazyGitHubResourceResolver, parseGitHubReferenceTarget, type IGitHubReferenceTarget } from './lazyGitHubResourceHover.js';

type LinkTarget =
	| { readonly kind: 'repository'; readonly owner: string; readonly repo: string; }
	| ({ readonly kind: 'issue' | 'pullRequest'; } & IGitHubReferenceTarget)
	| ({ readonly kind: 'commit'; } & IGitHubCommitTarget);

export class GitHubLinkPresentationContribution extends Disposable {
	public static readonly ID = 'workbench.contrib.githubLinkPresentations';
	private readonly registration = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		@IAccountService accounts: IAccountService,
		@IGitHubService private readonly github: IGitHubService,
		@ILinkPresentationService private readonly links: ILinkPresentationService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IOpenerService private readonly opener: IOpenerService,
		@ILogService private readonly log: ILogService,
		@INotificationService private readonly notifications: INotificationService,
		@IGitHubConnectionService private readonly connection: IGitHubConnectionService,
	) {
		super();
		this._register(accounts.onDidChangeAccounts(() => this.registerProviders()));
		this.registerProviders();
	}

	private registerProviders(): void {
		// Replacing a grant releases every reader before publishing rules for the new grant.
		this.registration.clear();
		const store = new DisposableStore();
		this.registration.value = store;
		const resolver = store.add(this.instantiation.createInstance(LazyGitHubResourceResolver));
		const commits = store.add(this.instantiation.createInstance(GitHubCommitResolver));
		const references = new Set<{ readonly resource: URI; readonly target: LinkTarget; }>();
		let authenticationShown = false;
		const reportError = (error: unknown): void => {
			this.log.warn('github', 'Could not load GitHub link details', error);
			if (error instanceof GitHubError && error.code === GitHubErrorCode.AuthenticationRequired && !authenticationShown) {
				authenticationShown = true;
				const notification = this.notifications.info(localize('github.authenticationRequired', 'Sign in to GitHub to load link details.'), [{
					id: 'github.signIn', label: localize('github.signIn', 'Sign in'), run: () => this.connection.connect(),
				}]);
				store.add(toDisposable(() => notification.close()));
			}
		};
		const createProvider = (kind: LinkPresentationKind): ILinkPresentationProvider => ({
			createLinkPresentationWatcher: (resource: URI): ILinkPresentationWatcher => {
				const target = parseTarget(resource);
				const watcher = new GitHubLinkWatcher(kind, reportError);
				if (!target) {
					watcher.load(async () => { throw new TypeError('Unsupported GitHub link identity'); });
					return watcher;
				}
				const reference = { resource, target };
				references.add(reference);
				watcher.addCleanup(() => {
					references.delete(reference);
					resolver.retain([...references]);
					commits.retain([...references].map(reference => reference.target).filter(target => target.kind === 'commit'));
				});
				const repositoryHref = `https://github.com/${target.owner}/${target.repo}`;
				const open = (href: string): void => {
					void this.opener.open(href, { openExternal: true, fromUserGesture: true, allowContributedOpeners: true }).catch(error => this.log.error('github', 'Could not open GitHub link', error));
				};
				const common = {
					owner: target.owner,
					repo: target.repo,
					repositoryHref,
					referenceHref: resource.toString(),
					density: 'default' as const,
					onDidClickRepository: () => open(repositoryHref),
					onDidClickReference: () => open(resource.toString()),
				};
				const detail = `${target.owner}/${target.repo}`;
				switch (target.kind) {
					case 'repository':
						watcher.load(async () => {
							const info = await this.github.readRepository({ host: 'github.com', owner: target.owner, name: target.repo }, watcher.token);
							const tooltip = `${info.fullName}\n${localize('github.defaultBranch', 'Default branch: {0}', info.defaultBranch)}`;
							return new GitHubResourcePresentation(
								{ kind: 'repository', title: info.fullName, tooltip },
								() => createRepositoryResourceHover({ ...common, repository: info }),
							);
						});
						break;
					case 'issue':
						watcher.addResource(autorun(reader => {
							const state = resolver.getIssueState(target).read(reader);
							if (state.status === 'resolved') {
								const issue = state.value;
								watcher.presentation.set(new GitHubResourcePresentation({
									kind: 'issue', title: issue.title, reference: `#${target.number}`, detail,
									status: getIssueResourceStatus(issue), tooltip: `${issue.title}\n\n${issue.body}`,
								}, () => createIssueResourceHover({ ...common, number: target.number, issue })));
							}
						}));
						watcher.load(async () => {
							await resolver.resolveIssue(target);
							return watcher.presentation.get()!;
						});
						break;
					case 'pullRequest': {
						const publish = (): void => {
							const state = resolver.getPullRequestState(target).get();
							if (state.status !== 'resolved' || watcher.isDisposed) {
								return;
							}
							const { pullRequest, checks } = state.value;
							const headHref = pullRequest.headRepository ? `https://github.com/${pullRequest.headRepository}/tree/${encodeURIComponent(pullRequest.headBranch)}` : undefined;
							const checksStatus = getPullRequestChecksStatus(checks);
							const secondaryStatus = checksStatus ? {
								kind: checksStatus === 'failure' ? 'error' as const : checksStatus,
								label: getPullRequestChecksStatusLabel(checksStatus),
							} : undefined;
							watcher.presentation.set(new GitHubResourcePresentation({
								kind: 'pullRequest', title: pullRequest.title, reference: `#${target.number}`, detail,
								status: getPullRequestResourceStatus(pullRequest), secondaryStatus,
								tooltip: `${pullRequest.title}\n${pullRequest.baseBranch} ← ${pullRequest.headBranch}\n\n${pullRequest.body}`,
							}, () => {
								// Resolve checks on intent and keep the core card usable if checks fail.
								void resolver.resolvePullRequest(target).catch(error => { if (!watcher.isDisposed) { reportError(error); } });
								return createPullRequestResourceHover({
									...common, number: target.number, pullRequest, checksStatus,
									onDidClickBaseBranch: () => open(`${repositoryHref}/tree/${encodeURIComponent(pullRequest.baseBranch)}`),
									headBranchLink: headHref ? { href: headHref, onClick: () => open(headHref) } : undefined,
								});
							}, computePullRequestIcon(getPullRequestResourceStatus(pullRequest).kind, { hasMergeConflicts: pullRequest.mergeable === false, hasFailingChecks: checksStatus === 'failure' })));
						};
						watcher.addResource(autorun(reader => {
							resolver.getPullRequestState(target).read(reader);
							publish();
						}));
						watcher.load(async () => {
							await resolver.prefetchPullRequest(target);
							publish();
							return watcher.presentation.get()!;
						});
						break;
					}
					case 'commit':
						watcher.addResource(autorun(reader => {
							const commit = commits.get(target).read(reader);
							if (commit) {
								watcher.presentation.set(new GitHubResourcePresentation({
									kind: 'commit', title: commit.message.split('\n')[0], reference: commit.sha.slice(0, 7), detail,
									changes: { insertions: commit.additions, deletions: commit.deletions },
									tooltip: `${commit.message}\n\n${commit.author}\n${commit.committedAt}`,
								}, () => createCommitResourceHover({ ...common, commit })));
							}
						}));
						watcher.load(async () => {
							await commits.resolve(target);
							return watcher.presentation.get()!;
						});
						break;
				}
				return watcher;
			},
		});
		const paths = { repository: '/?', commit: '/commit/[a-fA-F0-9]{7,40}', issue: '/issues/[1-9]\\d*', pullRequest: '/pull/[1-9]\\d*' };
		for (const kind of ['repository', 'issue', 'pullRequest', 'commit'] as const) {
			store.add(this.links.registerLinkPresentationProvider({ id: `workbench.github.${kind}LinkPresentation`, kind, uriPattern: new RegExp(`^https://github\\.com/[\\w.-]+/[\\w.-]+${paths[kind]}(?:[?#].*)?$`) }, createProvider(kind)));
		}
	}
}

class GitHubLinkWatcher extends Disposable implements ILinkPresentationWatcher {
	public readonly presentation = observableValue<ILinkPresentation | undefined>(this, undefined);
	private readonly cancellation = new CancellationTokenSource();
	public readonly token = this.cancellation.token;

	constructor(private readonly kind: LinkPresentationKind, private readonly reportError: (error: unknown) => void) {
		super();
		this._register(toDisposable(() => this.cancellation.dispose(true)));
	}

	public addResource(resource: IDisposable): void {
		this._register(resource);
	}

	public addCleanup(cleanup: () => void): void {
		this._register(toDisposable(cleanup));
	}

	public load(read: () => Promise<ILinkPresentation>): void {
		if (!this.presentation.get()) {
			this.presentation.set({ kind: this.kind, isLoading: true, tooltip: localize('github.loading', 'Loading GitHub details…') });
		}
		void this.resolve(read);
	}

	private async resolve(read: () => Promise<ILinkPresentation>): Promise<void> {
		try {
			const presentation = await read();
			if (!this.isDisposed) {
				this.presentation.set(presentation);
			}
		} catch (error) {
			if (!this.isDisposed) {
				this.presentation.set({ kind: this.kind, status: { kind: 'error', label: localize('github.failed', 'GitHub details unavailable') } });
				this.reportError(error);
			}
		}
	}
}

function parseTarget(resource: URI): LinkTarget | undefined {
	if (resource.scheme !== 'https' || resource.authority.toLowerCase() !== 'github.com') {
		return undefined;
	}
	const issue = parseGitHubReferenceTarget(resource, 'issue');
	if (issue) { return { kind: 'issue', ...issue }; }
	const pullRequest = parseGitHubReferenceTarget(resource, 'pullRequest');
	if (pullRequest) { return { kind: 'pullRequest', ...pullRequest }; }
	const commit = /^\/([\w.-]+)\/([\w.-]+)\/commit\/([a-fA-F0-9]{7,40})$/.exec(resource.path);
	if (commit) { return { kind: 'commit', owner: commit[1], repo: commit[2], sha: commit[3] }; }
	const repository = /^\/([\w.-]+)\/([\w.-]+)\/?$/.exec(resource.path);
	return repository ? { kind: 'repository', owner: repository[1], repo: repository[2] } : undefined;
}

// Opener resolves CodeEditorService; editor parts are registered by the BlockRestore phase.
registerWorkbenchContribution(GitHubLinkPresentationContribution.ID, WorkbenchPhase.BlockRestore, accessor => accessor.get(IInstantiationService).createInstance(GitHubLinkPresentationContribution));

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.GitHub,
	defaultValue: true,
	scope: ConfigurationScope.APPLICATION,
	schema: { type: 'boolean' },
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('GitHub accessibility verbosity must be boolean'); } return value; },
	setting: {
		valueType: 'boolean',
		get title() { return localize('github.verbosity', 'GitHub link accessibility help'); },
		get description() { return localize('github.verbosityDescription', 'Announce how to access GitHub link details with the keyboard.'); },
	},
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type, priority: 105, name: `github.${type}`,
		getProvider: accessor => {
			const focused = accessor.get(ILayoutService).mainContainer.ownerDocument.activeElement;
			if (!(focused instanceof HTMLElement)) { return undefined; }
			const content = focused.closest<HTMLElement>('[data-github-content]')?.dataset.githubContent;
			if (!content) { return undefined; }
			return new AccessibleContentProvider(AccessibleViewProviderId.GitHub, { type }, () => type === AccessibleViewType.Help
				? localize('github.help', 'GitHub link details\nPress Enter to open the link. Press F2 to focus its details card, then use Tab and Shift+Tab to reach the repository, reference and branch links. Escape closes the card and restores link focus. Open Accessible View to read the complete description.')
				: content, () => { if (focused.isConnected) { focused.focus(); } }, AccessibilityVerbositySettingId.GitHub);
		},
	});
}
