import { CancellationError } from '../../../../base/common/errors.js';
import { ContextView, ContextViewFocusRestore } from '../../../../base/browser/ui/contextview/contextview.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { GitHubError, GitHubMergeMethod, type GitHubRepository } from '../../../../platform/github/common/githubService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
import { URI } from '../../../../base/common/uri.js';
import { ISessionProviderScopeService, type ISessionProviderScope } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import type { ISessionPullRequestCreation, ISessionPullRequestOptions, SessionPullRequestMergeMethod } from '../common/pullRequestCreation.js';
import { CreatePullRequestChatRequest } from './createPullRequestChatRequest.js';
import { CreatePullRequestWidget, type ICreatePullRequestWidgetOptions } from './createPullRequestWidget.js';

/** Captures the Session's repository before mounting a transient creation form. */
export class CreatePullRequestContextView extends Disposable {
	private readonly formContextView: ContextView;
	private readonly widget = this._register(new MutableDisposable<CreatePullRequestWidget>());
	private readonly pending = this._register(new CancellationTokenSource());
	private readonly pickers = this._register(new DisposableStore());
	private readonly owner: string | undefined;
	private readonly scope: ISessionProviderScope | undefined;

	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextViewService private readonly contextViews: IContextViewService,
		@ISessionsService private readonly sessions: ISessionsService,
		@IQuickInputService private readonly input: IQuickInputService,
		@ISessionProviderScopeService private readonly scopes: ISessionProviderScopeService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		// The form outlives action menus, which use the window's shared context view.
		this.formContextView = this._register(new ContextView(contextViews.container));
		this.owner = this.selectionKey();
		this._register(sessions.onDidChange(() => { if (this.selectionKey() !== this.owner) { this.dispose(); } }));
		const selected = sessions.activeSelection;
		this.scope = selected?.kind === 'session' ? scopes.getScope(selected.active.session.sessionId) : undefined;
		if (this.scope) {
			const events = this.scope.services.host.events.subscribe(event => { if (event.method === 'account/updated' || event.method === 'account/login/completed') this.dispose(); });
			this._register(toDisposable(() => events.dispose()));
			const state = this.scope.services.host.appServer.onConnectionState(state => { if (state !== 'ready') this.dispose(); });
			this._register(toDisposable(() => state.dispose()));
		}
		this._register(scopes.onDidChangeScopes(() => { try { this.scope?.assertCurrent(); } catch { this.dispose(); } }));
	}

	private selectionKey(): string | undefined {
		const selected = this.sessions.activeSelection;
		return selected?.kind === 'session' ? JSON.stringify([selected.active.session.sessionId, selected.active.threadId, selected.active.session.workspace]) : undefined;
	}

	public async show(anchor: HTMLElement, creation?: ISessionPullRequestCreation): Promise<void> {
		let operation: ISessionPullRequestCreation | undefined;
		try { operation = creation ?? await this.prepareCreation(); }
		catch (error) {
			if (error instanceof GitHubError) { throw new Error(localize('sessions.changes.prAccountsError', 'Could not load GitHub accounts. Reconnect GitHub and try again.')); }
			throw error;
		}
		if (!operation || this.isDisposed) { return; }
		const options: ICreatePullRequestWidgetOptions = {
			creation: operation,
			onCancel: () => this.formContextView.hide(),
			onCreated: (_options, message) => { if (!this.isDisposed) { this.formContextView.hide(); } this.notifications.info(message); },
			onDetachedError: error => this.notifications.error(error.message),
			onSendToChat: operation.prepareChatRequest ? async request => {
				const selected = this.sessions.activeSelection;
				if (selected?.kind !== 'session' || this.isDisposed) { throw new CancellationError(); }
				const chat = selected.active.session.chats.find(chat => chat.threadId === selected.active.threadId);
				if (!chat) { throw new Error(localize('sessions.changes.prMissingChat', 'The initiating conversation is no longer available.')); }
				await this.instantiation.createInstance(CreatePullRequestChatRequest).send(selected.active.session, request, operation, chat);
				if (!this.isDisposed) { this.formContextView.hide(); }
				this.notifications.info(localize('sessions.changes.prSent', 'Pull request request submitted to the initiating conversation.'));
			} : undefined,
		};
		const widget = this.instantiation.createInstance(CreatePullRequestWidget, options, anchor.ownerDocument);
		this.widget.value = widget;
		if (this.formContextView.show({
			anchor, content: widget.domNode, presentation: 'plain', focusRestore: ContextViewFocusRestore.Previous,
			isTargetWithin: target => [...this.contextViews.container.querySelectorAll('[role="menu"]')].some(menu => menu.contains(target)),
			onHide: () => this.dispose(),
		})) { widget.focus(); }
		else { this.dispose(); }
		// Default values and merge options can change the form's anchored geometry.
		void widget.ready.then(() => { if (!this.isDisposed) { this.formContextView.layout(); } });
	}

	public override dispose(): void {
		if (this.isDisposed) { return; }
		this.pending.cancel();
		if (this.widget.value?.domNode.isConnected) { this.formContextView.hide(); }
		super.dispose();
	}

	private async pick<T extends IQuickPickItem>(items: readonly T[]): Promise<T | undefined> {
		if (items.length === 1) { return items[0]; }
		if (!items.length) { throw new Error(localize('sessions.changes.prUnavailable', 'No connected GitHub remote is available in this session directory.')); }
		const picker = this.input.createQuickPick<T>();
		this.pickers.add(picker);
		picker.items = items;
		picker.ariaLabel = picker.placeholder = localize('sessions.changes.prChooseRemote', 'Choose the repository and remote for the pull request');
		return new Promise(resolve => {
			this.pickers.add(toDisposable(() => resolve(undefined)));
			this.pickers.add(picker.onDidAccept(() => {
				const item = picker.selectedItems[0];
				if (!item) return;
				resolve(item); picker.hide();
			}));
			this.pickers.add(picker.onDidHide(() => this.pickers.clear()));
			picker.show();
		});
	}

	private async prepareCreation(): Promise<ISessionPullRequestCreation | undefined> {
		const selected = this.sessions.activeSelection;
		const workspace = selected?.kind === 'session' ? selected.active.session.workspace : undefined;
		if (!workspace || selected?.kind !== 'session') { return undefined; }
		const sessionId = selected.active.session.sessionId;
		const scope = this.scope;
		if (!scope) throw new CancellationError();
		const host = scope.services.host;
		const github = host.github;
		const generation = host.appServer.connectionGeneration;
		const backendSessionId = scope.backendIdentity(sessionId);
		const assertHostCurrent = (): void => {
			scope.assertCurrent();
			if (generation !== host.appServer.connectionGeneration) throw new CancellationError();
		};
		const root = sessionWorkspaceUri(workspace);
		const repositoriesForSession = async () => {
			assertHostCurrent();
			const contexts = await host.localGit.readRepositoryContexts({ sessionId: backendSessionId, path: workspace.root }, this.pending.token);
			assertHostCurrent();
			return contexts.map(repository => ({ ...repository, root: root.with({ path: URI.file(repository.rootPath).path }) }));
		};
		const [accounts, repositories] = await Promise.all([github.listAccounts(this.pending.token), repositoriesForSession()]);
		assertHostCurrent();
		if (this.isDisposed) { return undefined; }
		const sessionRepositories = repositories.filter(repository =>
			extUriBiasedIgnorePathCase.isEqualOrParent(repository.root, root)
			|| extUriBiasedIgnorePathCase.isEqualOrParent(root, repository.root));
		if (!sessionRepositories.length) { throw new Error(localize('sessions.changes.noRepository', 'No Git repository is available in this session directory.')); }
		const branches = sessionRepositories.filter(repository => repository.head.type === 'branch' && repository.head.objectId);
		if (!branches.length) { throw new Error(localize('sessions.changes.prNeedsBranch', 'Create a commit on a named branch before creating a pull request.')); }
		const choices = branches.flatMap(repository => repository.remotes.flatMap(remote => {
			const identity = remote.identity;
			const account = identity && accounts.find(account => account.status === 'ready' && account.host.toLowerCase() === identity.host.toLowerCase());
			return identity && account ? [{
				label: `${identity.host}/${identity.owner}/${identity.repository}`,
				description: `${repository.path} · ${remote.name}`,
				repository, remote, identity, account,
			}] : [];
		}));
		const choice = await this.pick(choices);
		if (!choice || this.isDisposed) { return undefined; }
		const target: GitHubRepository = { host: choice.identity.host, owner: choice.identity.owner, name: choice.identity.repository, accountId: choice.account.id };
		const repositoryName = `${target.host}/${target.owner}/${target.name}`;
		const validateContext = async (options: Pick<ISessionPullRequestOptions, 'expectedContext'>): Promise<void> => {
			assertHostCurrent();
			if (this.isDisposed || this.owner !== this.selectionKey()) { throw new CancellationError(); }
			const [freshRepositories, freshAccounts] = await Promise.all([repositoriesForSession(), github.listAccounts(this.pending.token)]);
			if (this.isDisposed) { throw new CancellationError(); }
			const fresh = freshRepositories.find(repository => repository.id === choice.repository.id);
			const account = freshAccounts.find(account => account.id === choice.account.id && account.status === 'ready' && account.credentialRevision === choice.account.credentialRevision);
			if (!account || !fresh
				|| !extUriBiasedIgnorePathCase.isEqual(fresh.root, choice.repository.root)
				|| fresh.head.type !== 'branch'
				|| fresh.head.name !== choice.repository.head.name
				|| fresh.head.objectId !== choice.repository.head.objectId
				|| !fresh.remotes.some(remote => remote.name === choice.remote.name && JSON.stringify(remote.identity) === JSON.stringify(choice.identity))
				|| options.expectedContext.repository !== repositoryName
				|| options.expectedContext.branchName !== fresh.head.name
				|| options.expectedContext.workingDirectory !== fresh.path) {
				throw new Error(localize('sessions.changes.prChanged', 'The branch, remote or account changed. Reopen the pull request form.'));
			}
		};
		return {
			prepare: async token => {
				assertHostCurrent();
				const info = await github.readRepository(target, token);
				assertHostCurrent();
				return {
					title: choice.repository.head.name,
					description: '',
					branchName: choice.repository.head.name,
					baseBranchName: info.defaultBranch,
					repository: repositoryName,
					autoMergeAllowed: info.allowAutoMerge,
					mergeMethods: [info.allowMergeCommit && 'MERGE', info.allowSquashMerge && 'SQUASH', info.allowRebaseMerge && 'REBASE'].filter((method): method is SessionPullRequestMergeMethod => !!method),
					context: {
						workingDirectory: choice.repository.path,
						repository: repositoryName,
						branchName: choice.repository.head.name,
						baseBranchName: info.defaultBranch,
					},
				};
			},
			prepareChatRequest: async (message, options) => { await validateContext(options); return message; },
			create: async options => {
				await validateContext(options);
				// Once submitted, completion belongs to the initiating Session even if the form closes.
				const result = await github.createPullRequest(target, {
					title: options.title,
					body: options.description,
					head: choice.repository.head.name,
					base: options.expectedContext.baseBranchName,
					draft: options.draft,
				});
				const warnings: string[] = [];
				const matchesLocalHead = result.headCommit === choice.repository.head.objectId;
				if (!matchesLocalHead) { warnings.push(localize('sessions.changes.prHeadChanged', 'The published branch differs from the local commit. Review the pull request before merging.')); }
				try { assertHostCurrent(); await github.attachSessionPullRequest(backendSessionId, { repository: { host: target.host, owner: target.owner, name: target.name }, number: result.number }); }
				catch { warnings.push(localize('sessions.changes.prAttachFailed', 'The pull request was created, but could not be attached to this session.')); }
				if (options.autoMergeMethod && matchesLocalHead && !options.draft) {
					try {
						assertHostCurrent();
						const method = { MERGE: GitHubMergeMethod.Merge, SQUASH: GitHubMergeMethod.Squash, REBASE: GitHubMergeMethod.Rebase }[options.autoMergeMethod];
						await github.enableAutoMerge(target, result.number, { commit: result.headCommit, method });
					} catch { warnings.push(localize('sessions.changes.prAutoFailed', 'The pull request was created, but auto-merge could not be enabled.')); }
				}
				return [localize('sessions.changes.prCreated', 'Created pull request: {0}', result.url), ...warnings].join('\n');
			},
		};
	}
}
