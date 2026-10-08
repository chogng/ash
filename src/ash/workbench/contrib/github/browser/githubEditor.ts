import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import './githubEditor.css';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { SelectBox } from '../../../../base/browser/ui/selectbox/selectbox.js';
import type { IAction } from '../../../../base/common/actions.js';
import { CancellationTokenSource, throwIfCancelled } from '../../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { WorkerDiffComputationService } from '../../../../editor/browser/services/workerDiffComputationService.js';
import { DiffEditorWidget } from '../../../../editor/browser/widget/diffEditor/diffEditorWidget.js';
import { DiffModel } from '../../../../editor/common/diff/diffModel.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId, AccessibleViewType, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { GitHubNotificationFilter, GitHubForkBranches, GitHubDiffSide, GitHubError, GitHubErrorCode, GitHubIssueState, GitHubMergeMethod, GitHubReviewEvent, GitHubReviewThreadState, GitHubReviewerChange, IGitHubService, type GitHubFileContent, type GitHubPullRequestFile, type GitHubReviewThread } from '../../../../platform/github/common/githubService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IGitHubConnectionService } from '../../../services/accounts/common/gitHubConnectionService.js';
import { IGitService } from '../../git/common/gitService.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import type { IResourceEditorInput, IEditorPane } from '../../../common/editor.js';
import { ITextModelResourceService } from '../../../services/textmodelResolver/common/textModelResourceService.js';
import { IGitHubReviewModel, isReviewLine, type GitHubComposeDraft } from './githubReviewModel.js';

export const githubEditorId = 'ash.githubEditor';

/** The pane owns widgets and immutable text references; the window model owns review drafts. */
export class GitHubEditor extends EditorPane implements IEditorPane {
	public readonly id = githubEditorId;
	private root!: HTMLDivElement;
	private account!: SelectBox;
	private shownAccounts: unknown;
	private reviewers!: HTMLParagraphElement;
	private reviewerActions!: WorkbenchToolBar;
	private localActions!: WorkbenchToolBar;
	private owner!: InputBox;
	private repositoryName!: InputBox;
	private mode!: SelectBox;
	private filter!: SelectBox;
	private notificationFilter!: SelectBox;
	private headerActions!: WorkbenchToolBar;
	private status!: HTMLParagraphElement;
	private list!: HTMLDivElement;
	private listActions!: WorkbenchToolBar;
	private detail!: HTMLDivElement;
	private metadata!: HTMLDivElement;
	private detailActions!: WorkbenchToolBar;
	private checks!: HTMLDivElement;
	private checksActions!: WorkbenchToolBar;
	private files!: SelectBox;
	private fileActions!: WorkbenchToolBar;
	private diffContainer!: HTMLDivElement;
	private diffNotice!: HTMLParagraphElement;
	private reviewSection!: HTMLDivElement;
	private reviewBody!: HTMLTextAreaElement;
	private inlineBody!: HTMLTextAreaElement;
	private lineLabel!: HTMLParagraphElement;
	private inlineActions!: WorkbenchToolBar;
	private drafts!: HTMLDivElement;
	private reviewActions!: WorkbenchToolBar;
	private mergeMethod!: SelectBox;
	private mergeActions!: WorkbenchToolBar;
	private discussions!: HTMLDivElement;
	private discussionActions!: WorkbenchToolBar;
	private codexActions!: WorkbenchToolBar;
	private codexNotice!: HTMLParagraphElement;
	private issueSection!: HTMLDivElement;
	private issueComments!: HTMLDivElement;
	private issueReply!: HTMLTextAreaElement;
	private issueActions!: WorkbenchToolBar;
	private form!: HTMLDivElement;
	private formTarget!: HTMLParagraphElement;
	private formTitle!: InputBox;
	private formBody!: HTMLTextAreaElement;
	private formHead!: InputBox;
	private formBase!: InputBox;
	private formLabels!: InputBox;
	private formAssignees!: InputBox;
	private formDraft!: HTMLInputElement;
	private formActions!: WorkbenchToolBar;
	private shownCompose: GitHubComposeDraft | undefined;
	private shownFiles: readonly GitHubPullRequestFile[] | undefined;
	private shownItems: unknown;
	private shownThreads: unknown;
	private shownDrafts: string | undefined;
	private shownReviews: unknown;
	private shownComments: unknown;
	private threadInteractionState = '';
	private selectedFile: GitHubPullRequestFile | undefined;
	private selectedSide = GitHubDiffSide.Right;
	private selectedLine = 1;
	private diffIdentity: string | undefined;
	private readonly diffSession = this._register(new MutableDisposable<DisposableStore>());
	private diffCancellation = new CancellationTokenSource();
	private readonly listResources = this._register(new DisposableStore());
	private readonly threadResources = this._register(new DisposableStore());
	private readonly draftResources = this._register(new DisposableStore());
	private readonly replies = new Map<string, string>();
	private accountEpoch = 0;

	constructor(
		@IGitHubReviewModel private readonly model: IGitHubReviewModel,
		@IGitHubService private readonly github: IGitHubService,
		@IGitService private readonly git: IGitService,
		@IWorkingCopyService private readonly workingCopies: IWorkingCopyService,
		@IGitHubConnectionService private readonly connection: IGitHubConnectionService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextMenuService private readonly contextMenu: IContextMenuService,
		@IContextViewService private readonly contextView: IContextViewService,
		@ITextModelResourceService private readonly models: ITextModelResourceService,
		@IOpenerService private readonly opener: IOpenerService,
		@IPreferencesService private readonly preferences: IPreferencesService,
		@IDialogService private readonly dialogs: IDialogService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IAccessibleViewService private readonly accessibleView: IAccessibleViewService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) { super(githubEditorId, themeService, storageService); }

	public override create(parent: HTMLElement): void {
		this.root = h(parent.ownerDocument, 'div'); this.root.className = 'ash-github-editor'; parent.append(this.root);
		super.create(this.root);
		this.root.setAttribute('aria-label', localize('github.editor.title', 'GitHub Pull Requests and Issues'));
		const header = this.element(this.root, 'github-header');
		this.account = this.select(header, localize('github.editor.account', 'GitHub account'), []);
		this._register(this.account.onDidSelect(() => this.model.selectAccount(this.account.value ?? '')));
		this.owner = this.input(header, localize('github.editor.owner', 'Owner'), 'owner');
		this.repositoryName = this.input(header, localize('github.editor.repository', 'Repository'), 'repository');
		this.mode = this.select(header, localize('github.editor.resourceType', 'Resource type'), [
			{ value: 'pullRequests', label: localize('github.editor.prs', 'Pull requests') }, { value: 'issues', label: localize('github.editor.issues', 'Issues') },
			{ value: 'notifications', label: localize('github.editor.notifications', 'Notifications') },
		]);
		this.filter = this.select(header, localize('github.editor.state', 'State'), [
			{ value: GitHubIssueState.Open, label: localize('github.editor.open', 'Open') }, { value: GitHubIssueState.Closed, label: localize('github.editor.closed', 'Closed') },
		]);
		this.notificationFilter = this.select(header, localize('github.editor.notificationFilter', 'Notification filter'), [
			{ value: GitHubNotificationFilter.Unread, label: localize('github.editor.unread', 'Unread') },
			{ value: GitHubNotificationFilter.All, label: localize('github.editor.allNotifications', 'All notifications') },
			{ value: GitHubNotificationFilter.Participating, label: localize('github.editor.participating', 'Participating') },
		]);
		this._register(this.mode.onDidSelect(() => { this.updateFilters(); }));
		this.headerActions = this.toolbar(header, localize('github.editor.repositoryActions', 'Repository actions'));
		this.status = h(parent.ownerDocument, 'p'); this.status.className = 'github-status'; this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite'); this.root.append(this.status);
		const content = this.element(this.root, 'github-content');
		const sidebar = this.element(content, 'github-sidebar');
		this.list = this.element(sidebar, 'github-list'); this.list.setAttribute('role', 'list');
		this.listActions = this.toolbar(sidebar, localize('github.editor.listActions', 'List actions'));
		this.detail = this.element(content, 'github-detail');
		this.metadata = this.element(this.detail, 'github-metadata'); this.detailActions = this.toolbar(this.detail, localize('github.editor.detailActions', 'Pull request and issue actions'));
		this.form = this.element(this.detail, 'github-form'); this.form.hidden = true;
		this.formTarget = h(parent.ownerDocument, 'p'); this.form.append(this.formTarget);
		this.formTitle = this.input(this.form, localize('github.editor.formTitle', 'Title'), 'formTitle');
		this.formBody = this.textarea(this.form, localize('github.editor.description', 'Description'), 'formBody');
		this.formHead = this.input(this.form, localize('github.editor.head', 'Source branch (owner:branch for a fork)'), 'formHead');
		this.formBase = this.input(this.form, localize('github.editor.base', 'Target branch'), 'formBase');
		this.formLabels = this.input(this.form, localize('github.editor.labels', 'Labels, separated by commas'), 'formLabels');
		this.formAssignees = this.input(this.form, localize('github.editor.assignees', 'Assignees, separated by commas'), 'formAssignees');
		const draftLabel = this.element(this.form, 'github-checkbox', 'label'); draftLabel.append(h(parent.ownerDocument, 'span', localize('github.editor.draft', 'Draft pull request')));
		this.formDraft = h(parent.ownerDocument, 'input'); this.formDraft.type = 'checkbox'; draftLabel.append(this.formDraft);
		for (const [input, key] of [[this.formTitle, 'title'], [this.formHead, 'head'], [this.formBase, 'base'], [this.formLabels, 'labels'], [this.formAssignees, 'assignees']] as const) {
			this._register(input.onDidChange(value => { if (this.model.compose) { this.model.compose[key] = value; } }));
		}
		this._register(addDisposableListener(this.formBody, 'input', () => { if (this.model.compose) { this.model.compose.body = this.formBody.value; } }));
		this._register(addDisposableListener(this.formDraft, 'change', () => { if (this.model.compose) { this.model.compose.draft = this.formDraft.checked; } }));
		this.formActions = this.toolbar(this.form, localize('github.editor.formActions', 'Form actions'));
		this.reviewSection = this.element(this.detail, 'github-review');
		this.codexActions = this.toolbar(this.reviewSection, localize('github.editor.codexActions', 'Codex review actions'));
		this.codexNotice = h(parent.ownerDocument, 'p'); this.codexNotice.setAttribute('role', 'status'); this.codexNotice.setAttribute('aria-live', 'polite'); this.reviewSection.append(this.codexNotice);
		this.reviewers = h(parent.ownerDocument, 'p'); this.reviewSection.append(this.reviewers);
		this.reviewerActions = this.toolbar(this.reviewSection, localize('github.editor.reviewerActions', 'Reviewer actions'));
		this.localActions = this.toolbar(this.reviewSection, localize('github.editor.localActions', 'Local repository actions'));
		this.checks = this.element(this.reviewSection, 'github-checks'); this.checksActions = this.toolbar(this.reviewSection, localize('github.editor.checkActions', 'Checks actions'));
		this.files = this.select(this.reviewSection, localize('github.editor.files', 'Changed files'), []);
		this._register(this.files.onDidSelect(() => { void this.openFile(); }));
		this.fileActions = this.toolbar(this.reviewSection, localize('github.editor.fileActions', 'File actions'));
		this.diffNotice = h(parent.ownerDocument, 'p'); this.diffNotice.setAttribute('role', 'status'); this.reviewSection.append(this.diffNotice);
		this.diffContainer = this.element(this.reviewSection, 'github-diff');
		this.lineLabel = h(parent.ownerDocument, 'p'); this.reviewSection.append(this.lineLabel);
		this.inlineBody = this.textarea(this.reviewSection, localize('github.editor.inlineComment', 'Comment on selected line'), 'inlineComment');
		this.inlineActions = this.toolbar(this.reviewSection, localize('github.editor.inlineActions', 'Line comment actions'));
		this.drafts = this.element(this.reviewSection, 'github-draft-comments');
		this.reviewBody = this.textarea(this.reviewSection, localize('github.editor.reviewSummary', 'Review summary'), 'reviewSummary');
		this._register(addDisposableListener(this.reviewBody, 'input', () => this.model.setReviewBody(this.reviewBody.value)));
		this.reviewActions = this.toolbar(this.reviewSection, localize('github.editor.reviewActions', 'Review actions'));
		this.mergeMethod = this.select(this.reviewSection, localize('github.editor.mergeMethod', 'Merge method'), []);
		this.mergeActions = this.toolbar(this.reviewSection, localize('github.editor.mergeActions', 'Merge actions'));
		this.discussions = this.element(this.reviewSection, 'github-discussions'); this.discussionActions = this.toolbar(this.reviewSection, localize('github.editor.discussionActions', 'Discussion actions'));
		this.issueSection = this.element(this.detail, 'github-issue');
		this.issueComments = this.element(this.issueSection, 'github-issue-comments');
		this.issueReply = this.textarea(this.issueSection, localize('github.editor.issueComment', 'Issue comment'), 'issueComment');
		this.issueActions = this.toolbar(this.issueSection, localize('github.editor.issueActions', 'Issue actions'));
		this._register(this.model.onDidChange(() => this.render()));
		this._register(addDisposableListener(this.root, 'keydown', event => {
			if (event.altKey && event.code === 'F1') { event.preventDefault(); this.accessibleView.show(AccessibleViewType.Help); }
		}));
		this._register(addDisposableListener(this.root, 'click', event => {
			const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[data-github-link]') : null;
			if (link && this.root.contains(link)) { event.preventDefault(); void this.opener.open(link.href, { openExternal: true, fromUserGesture: true }); }
		}));
		this._register(this.configuration.onDidChangeConfiguration(event => { if (event.affectsConfiguration(AccessibilityVerbositySettingId.GitHubEditor)) { this.render(); } }));
		this._register(toDisposable(() => { this.diffCancellation.dispose(true); this.root.remove(); }));
		this.render();
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		throwIfCancelled(signal);
		const cancel = () => this.model.cancelLoading();
		signal.addEventListener('abort', cancel, { once: true });
		try {
			await this.model.initialize();
			if (input.resource.authority) {
				const id = new URLSearchParams(input.resource.query).get('account');
				const account = this.model.accounts.find(account => account.host === input.resource.authority && account.status === 'ready' && (id ? account.id === id : account.id === this.model.selectedAccount?.id))
					?? this.model.accounts.find(account => account.host === input.resource.authority && account.status === 'ready' && (!id || account.id === id));
				if (!account) { throw new GitHubError(GitHubErrorCode.AuthenticationRequired); }
				this.model.selectAccount(account.id);
			}
			const repo = this.model.repository;
			this.owner.value = repo?.owner ?? '';
			this.repositoryName.value = repo?.name ?? '';
			const parts = input.resource.path.split('/').filter(Boolean);
			const mode = parts[2] === 'issues' ? 'issues' : 'pullRequests';
			if (parts.length >= 2 && (repo?.owner !== parts[0] || repo?.name !== parts[1] || repo?.accountId !== this.model.selectedAccount?.id || this.model.mode !== mode)) { this.owner.value = parts[0]!; this.repositoryName.value = parts[1]!; await this.model.loadRepository(parts[0]!, parts[1]!, mode); }
			throwIfCancelled(signal);
			if (parts[2] === 'pull' && /^\d+$/.test(parts[3] ?? '')) { await this.model.openPullRequest(Number(parts[3])); }
			if (parts[2] === 'issues' && /^\d+$/.test(parts[3] ?? '')) { await this.model.openIssue(Number(parts[3])); }
			throwIfCancelled(signal);
			this.render();
		} finally { signal.removeEventListener('abort', cancel); }
	}
	public override clearInput(): void { this.diffCancellation.dispose(true); this.diffSession.clear(); this.diffIdentity = undefined; }
	public override layout(dimension: IDimension): void { this.root.style.width = `${dimension.width}px`; this.root.style.height = `${dimension.height}px`; this.root.classList.toggle('compact', dimension.width < 800); }
	public override focus(): void { if (this.model.mode === 'notifications') { this.notificationFilter.focus(); } else { this.owner.focus(); } }
	public override getControl(): HTMLElement { return this.root; }
	public accessibleContent(): string {
		const selected = this.model.pullRequest ?? this.model.issue;
		return [this.model.selectedAccount && `${this.model.selectedAccount.login}@${this.model.selectedAccount.host}`, this.model.notifications.map(row => `${row.unread ? localize('github.editor.unread', 'Unread') : ''} ${row.repository.owner}/${row.repository.name}: ${row.title} (${row.reason})`).join('\n'), this.model.fork && localize('github.editor.forkAccepted', 'Fork creation accepted: {0}. GitHub may still be copying the repository.', this.model.fork.fullName), this.reviewers.textContent, this.status.textContent, selected && `#${selected.number} ${selected.title}\n${selected.body}`, this.model.checks?.checks.map(check => `${check.name}: ${check.conclusion ?? check.status}`).join('\n'), this.model.files.map(file => `${file.filename} +${file.additions} −${file.deletions}`).join('\n'), this.model.threads.map(thread => `${thread.path}:${thread.line ?? ''}\n${thread.comments.comments.map(comment => `${comment.author ?? ''}: ${comment.body}`).join('\n')}`).join('\n\n'), this.model.reviews.map(review => `${review.state}: ${review.body}`).join('\n'), this.codexNotice.textContent, this.model.pullRequestComments.map(comment => comment.body).join('\n'), this.model.issue?.comments.map(comment => comment.body).join('\n'), this.model.draft?.body, this.model.draft?.comments.map(comment => `${comment.path}:${comment.line}\n${comment.body}`).join('\n')].filter(Boolean).join('\n\n');
	}

	private render(): void {
		const model = this.model;
		const active = this.root.ownerDocument.activeElement;
		const focusKey = active instanceof HTMLElement && this.root.contains(active) ? active.dataset.githubFocus ?? active.getAttribute('aria-label') : null;
		if (model.accountEpoch !== this.accountEpoch) {
			this.accountEpoch = model.accountEpoch; this.replies.clear(); this.form.hidden = true; this.formBody.value = ''; this.inlineBody.value = ''; this.issueReply.value = '';
			for (const input of [this.formTitle, this.formHead, this.formBase, this.formLabels, this.formAssignees]) { input.value = ''; }
		}
		if (this.shownAccounts !== model.accounts) {
			this.shownAccounts = model.accounts; this.account.setOptions(model.accounts.map(account => ({ value: account.id, label: `${account.login}@${account.host}` })));
		}
		this.account.value = model.selectedAccount?.id; this.account.enabled = !model.busy;
		this.mode.value = model.mode; this.filter.value = model.filter; this.notificationFilter.value = model.notificationFilter; this.updateFilters();
		this.owner.enabled = this.repositoryName.enabled = this.mode.enabled = this.filter.enabled = !model.busy;
		this.headerActions.setActions([
			this.action('load', model.mode === 'notifications' ? localize('github.editor.loadNotifications', 'Refresh notifications') : localize('github.editor.load', 'Load repository'), !model.busy, () => this.load()),
			this.action('signIn', localize('github.editor.signIn', 'Sign in to GitHub'), !this.connection.isConnecting, () => this.connection.connect()),
		], [this.action('enterpriseSignIn', localize('github.editor.enterpriseSignIn', 'Sign in to GitHub Enterprise'), !model.busy && !this.connection.isConnecting, () => this.connectEnterprise()), this.action('fork', localize('github.editor.fork', 'Create fork'), !model.busy && !model.submissionUncertain && !!model.repositoryInfo && model.mode !== 'notifications', () => this.createFork()), this.action('connectToken', localize('github.editor.connectToken', 'Connect with token'), !model.busy, () => this.connectToken()), this.action('logout', localize('github.editor.logout', 'Sign out selected account'), !model.busy && !!model.selectedAccount, () => model.logoutSelectedAccount()), this.action('help', localize('github.editor.helpAction', 'Accessibility help'), true, () => this.accessibleView.show(AccessibleViewType.Help)), this.action('acknowledge', localize('github.editor.acknowledge', 'Result verified; start another operation'), model.submissionUncertain && !model.busy, async () => {
			if ((await this.dialogs.confirm({ message: localize('github.editor.acknowledgeConfirm', 'Have you verified the previous operation on GitHub?'), detail: localize('github.editor.acknowledgeDetail', 'Confirmation unlocks new operations and discards any review draft with an uncertain outcome.') })).confirmed) { model.acknowledgeSubmission(); }
		})]);
		this.status.textContent = model.busy ? localize('github.editor.loading', 'Loading GitHub…') : model.error ? githubErrorMessage(model.error) : model.staleDraft ? localize('github.editor.staleDraft', 'The PR changed. Your draft belongs to an earlier commit. Discard it before starting a new review.') : model.submissionUncertain ? localize('github.editor.uncertain', 'GitHub may have accepted the operation. Verify the result on GitHub before starting another operation.') : model.mode === 'notifications' ? localize('github.editor.notificationAccess', 'Notifications require an OAuth App authorization or a classic token with the notifications scope. GitHub App and fine-grained tokens are not supported.') : model.repositoryInfo ? localize('github.editor.loaded', 'Loaded {0}', model.repositoryInfo.fullName) : localize('github.editor.start', 'Enter a GitHub repository owner and name, then load the repository.');
		this.status.classList.toggle('error', !!model.error || model.staleDraft || !!model.draft?.uncertain);
		this.root.setAttribute('aria-busy', String(model.busy));
		if (this.configuration.getValue<boolean>(AccessibilityVerbositySettingId.GitHubEditor)) { this.root.setAttribute('aria-description', localize('github.editor.helpHint', 'Press Alt+F1 for GitHub keyboard help.')); }
		else { this.root.removeAttribute('aria-description'); }
		const items = model.mode === 'notifications' ? model.notifications : model.mode === 'pullRequests' ? model.pullRequests : model.issues;
		if (this.shownItems !== items) {
			this.shownItems = items; this.listResources.clear(); this.list.replaceChildren();
			for (const item of items) {
				const row = this.element(this.list, 'github-list-item'); row.setAttribute('role', 'listitem');
				const notification = 'id' in item ? item : undefined;
				const label = notification ? `${notification.unread ? localize('github.editor.unread', 'Unread') + ' · ' : ''}${notification.repository.owner}/${notification.repository.name} · ${notification.title}` : `#${'number' in item ? item.number : ''} ${item.title}`;
				const button = this.listResources.add(new Button(row, {
					label, presentation: 'quiet', onClick: () => {
						if (notification) { model.selectNotification(notification); return; }
						if ('number' in item) { this.inlineBody.value = ''; this.issueReply.value = ''; void (model.mode === 'pullRequests' ? model.openPullRequest(item.number) : model.openIssue(item.number)); }
					}
				}));
				button.domNode.dataset.githubFocus = notification ? `notification-${notification.id}` : `item-${'number' in item ? item.number : ''}`;
			}
			this.listResources.add(addDisposableListener(this.list, 'keydown', event => {
				if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { return; }
				const buttons = [...this.list.querySelectorAll<HTMLButtonElement>('button')]; const index = buttons.indexOf(this.root.ownerDocument.activeElement as HTMLButtonElement);
				const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
				event.preventDefault(); buttons[next]?.focus();
			}));
		}
		for (const button of this.list.querySelectorAll<HTMLButtonElement>('button')) { button.disabled = model.busy; }
		this.listActions.setActions([
			this.action('more', localize('github.editor.more', 'Load more'), !model.busy && model.nextPage !== null, () => model.moreItems()),
			this.action('new', localize('github.editor.new', 'Create'), !model.busy && !model.submissionUncertain && !!model.repositoryInfo && model.mode !== 'notifications', () => this.showForm('new')),
		], [this.action('readAllNotifications', localize('github.editor.readAllNotifications', 'Mark all notifications read'), model.mode === 'notifications' && !model.busy && !model.submissionUncertain && !!model.selectedAccount, () => model.markNotificationsRead())]);
		const selected = model.pullRequest ?? model.issue;
		this.metadata.replaceChildren();
		if (selected) {
			this.metadata.append(h(this.root.ownerDocument, 'h2', `#${selected.number} ${selected.title}`));
			this.link(this.metadata, localize('github.editor.viewOnGitHub', 'View on GitHub'), selected.url);
			this.metadata.append(h(this.root.ownerDocument, 'p', selected.state), h(this.root.ownerDocument, 'pre', selected.body));
			if (model.pullRequest) { this.metadata.append(h(this.root.ownerDocument, 'p', `${model.pullRequest.baseBranch} ← ${model.pullRequest.headBranch} · ${model.pullRequest.headCommit.slice(0, 7)}`)); }
		} else { this.metadata.append(h(this.root.ownerDocument, 'p', localize('github.editor.select', 'Select a pull request or issue from the list.'))); }
		this.detailActions.setActions([
			this.action('refresh', localize('github.editor.refresh', 'Refresh'), !model.busy && !!selected, () => model.pullRequest ? model.openPullRequest(model.pullRequest.number) : model.openIssue(model.issue!.number)),
			this.action('edit', localize('github.editor.edit', 'Edit'), model.ready && !model.busy && !model.submissionUncertain && !!selected, () => this.showForm('edit')),
		], [this.action('changeState', selected?.state === 'open' ? localize('github.editor.close', 'Close') : localize('github.editor.reopen', 'Reopen'), model.ready && !model.busy && !model.submissionUncertain && !!selected && !model.pullRequest?.mergedAt, () => model.updateItem(selected!.number, model.pullRequest ? 'pullRequests' : 'issues', { state: selected!.state === 'open' ? GitHubIssueState.Closed : GitHubIssueState.Open }))]);
		if (model.mode === 'notifications') {
			this.metadata.replaceChildren();
			const notification = model.selectedNotification;
			if (notification) {
				this.metadata.append(h(this.root.ownerDocument, 'h2', notification.title), h(this.root.ownerDocument, 'p', `${notification.repository.owner}/${notification.repository.name} · ${notification.subjectType} · ${notification.reason}`));
				this.link(this.metadata, localize('github.editor.viewOnGitHub', 'View on GitHub'), notification.url);
			}
			if (model.notificationsReadAccepted) { this.metadata.append(h(this.root.ownerDocument, 'p', localize('github.editor.readAccepted', 'GitHub accepted the request to mark all notifications read. Refresh to check the latest state.'))); }
			this.detailActions.setActions([this.action('readNotification', localize('github.editor.readNotification', 'Mark notification read'), !!notification?.unread && !model.busy && !model.submissionUncertain, () => model.markNotificationRead())]);
		}
		if (model.fork && model.mode !== 'notifications') {
			this.metadata.append(h(this.root.ownerDocument, 'p', localize('github.editor.forkAccepted', 'Fork creation accepted: {0}. GitHub may still be copying the repository.', model.fork.fullName)));
			this.link(this.metadata, localize('github.editor.openFork', 'Open fork on GitHub'), model.fork.url);
		}
		this.reviewSection.hidden = !model.pullRequest;
		this.issueSection.hidden = !model.issue;
		this.renderReview(); this.renderIssue(); this.renderFormActions();
		if (focusKey && active instanceof HTMLElement && !active.isConnected) {
			const target = [...this.root.querySelectorAll<HTMLElement>('[data-github-focus], [aria-label]')].find(element => (element.dataset.githubFocus ?? element.getAttribute('aria-label')) === focusKey);
			target?.focus();
		}
	}

	private renderReview(): void {
		const model = this.model;
		this.codexActions.setActions([
			this.action('requestCodexReview', localize('github.editor.requestCodex', 'Request Codex review'), model.canWrite && !model.codexReviewRequested && model.repository?.host === 'github.com', () => model.requestCodexReview()),
			this.action('codexSettings', localize('github.editor.codexSettings', 'Codex review settings'), true, () => this.preferences.openSettings({ section: 'github' })),
		]);
		this.codexNotice.textContent = model.codexReviewRequested
			? localize('github.editor.codexRequested', 'Posted @codex review. Refresh to read PR comments and review discussions. The official Connector must be authorized for this repository.')
			: localize('github.editor.codexHint', 'Request Codex review posts @codex review using your GitHub account. Configure the official Connector in Codex review settings.');
		this.checks.replaceChildren(h(this.root.ownerDocument, 'h3', localize('github.editor.checks', 'Checks')));
		if (model.checks) {
			this.checks.append(h(this.root.ownerDocument, 'p', model.checks.state));
			for (const check of model.checks.checks) { const text = `${check.name}: ${check.conclusion ?? check.status}`; if (check.detailsUrl) { this.link(this.checks, text, check.detailsUrl); } else { this.checks.append(h(this.root.ownerDocument, 'p', text)); } }
			for (const status of model.checks.statuses) { const text = `${status.context}: ${status.state}${status.description ? ` — ${status.description}` : ''}`; if (status.targetUrl) { this.link(this.checks, text, status.targetUrl); } else { this.checks.append(h(this.root.ownerDocument, 'p', text)); } }
		}
		this.checksActions.setActions([this.action('moreChecks', localize('github.editor.moreChecks', 'Load more checks'), !model.busy && !!model.checks?.nextPage, () => model.moreChecks())]);
		if (this.shownFiles !== model.files) {
			this.shownFiles = model.files;
			this.files.setOptions(model.files.map(file => ({ value: file.filename, label: `${file.filename} · +${file.additions} −${file.deletions}` })));
			void this.openFile();
		}
		this.files.enabled = !model.busy;
		this.fileActions.setActions([this.action('moreFiles', localize('github.editor.moreFiles', 'Load more files'), !model.busy && model.nextFilesPage !== null, () => model.moreFiles())]);
		if (model.filesLimitReached) { this.diffNotice.textContent = localize('github.editor.fileLimit', 'GitHub limits the file list to 3,000 files. Open the PR on GitHub to inspect the complete change.'); }
		this.reviewers.textContent = localize('github.editor.reviewers', 'Requested reviewers: {0}', [...model.requestedReviewers.users, ...model.requestedReviewers.teams.map(team => `@${team}`)].join(', '));
		this.reviewerActions.setActions([
			this.action('requestReviewers', localize('github.editor.requestReviewers', 'Request reviewers'), model.canWrite, () => this.changeReviewers(GitHubReviewerChange.Request)),
			this.action('removeReviewers', localize('github.editor.removeReviewers', 'Remove reviewers'), model.canWrite && (model.requestedReviewers.users.length + model.requestedReviewers.teams.length > 0), () => this.changeReviewers(GitHubReviewerChange.Remove)),
		]);
		this.localActions.setActions([
			this.action('checkout', localize('github.editor.checkout', 'Check out pull request'), !model.busy && !!model.pullRequest, () => this.localOperation('checkout')),
			this.action('push', localize('github.editor.push', 'Push local commits to pull request'), !model.busy && !!model.pullRequest?.headRepository && model.pullRequest.state === 'open', () => this.localOperation('push')),
		]);

		const editable = model.canWrite;
		this.reviewBody.disabled = !editable; this.inlineBody.disabled = !editable;
		this.reviewBody.value = model.draft?.body ?? '';
		this.updateInlineActions();
		const draftIdentity = JSON.stringify({ comments: model.draft?.comments ?? [], busy: model.busy, uncertain: model.submissionUncertain });
		if (this.shownDrafts !== draftIdentity) {
			this.shownDrafts = draftIdentity; this.draftResources.clear(); this.drafts.replaceChildren();
			for (const [index, comment] of (model.draft?.comments ?? []).entries()) {
				const row = this.element(this.drafts, 'github-thread'); row.append(h(this.root.ownerDocument, 'strong', `${comment.path}:${comment.line} (${comment.side})`), h(this.root.ownerDocument, 'pre', comment.body));
				const toolbar = this.toolbar(row, localize('github.editor.draftActions', 'Draft comment actions'), this.draftResources);
				toolbar.setActions([this.action(`remove-${index}`, localize('github.editor.removeComment', 'Remove comment'), !model.busy && !model.draft?.uncertain, () => model.removeComment(index))]);
			}
		}
		const canReview = editable && !model.pullRequest?.draft;
		this.reviewActions.setActions([
			this.action('comment', localize('github.editor.submitReview', 'Submit review'), editable, () => model.submitReview(GitHubReviewEvent.Comment)),
			this.action('approve', localize('github.editor.approve', 'Approve'), canReview, () => model.submitReview(GitHubReviewEvent.Approve)),
			this.action('requestChanges', localize('github.editor.requestChanges', 'Request changes'), canReview, () => model.submitReview(GitHubReviewEvent.RequestChanges)),
		], [this.action('discardDraft', localize('github.editor.discard', 'Discard review draft'), !model.busy && !!model.draft, async () => {
			if ((await this.dialogs.confirm({ message: localize('github.editor.discardConfirm', 'Discard this review draft?'), detail: model.draft?.uncertain ? localize('github.editor.verifyFirst', 'The previous submission may have succeeded. Verify it on GitHub before discarding the draft and creating another review.') : undefined })).confirmed) { model.discardDraft(); }
		})]);
		const info = model.repositoryInfo;
		const methods = [
			...(info?.allowSquashMerge ? [{ value: GitHubMergeMethod.Squash, label: localize('github.editor.squash', 'Squash and merge') }] : []),
			...(info?.allowMergeCommit ? [{ value: GitHubMergeMethod.Merge, label: localize('github.editor.mergeCommit', 'Create a merge commit') }] : []),
			...(info?.allowRebaseMerge ? [{ value: GitHubMergeMethod.Rebase, label: localize('github.editor.rebase', 'Rebase and merge') }] : []),
		];
		this.mergeMethod.setOptions(methods); this.mergeMethod.enabled = canReview;
		this.mergeActions.setActions([this.action('merge', localize('github.editor.merge', 'Merge pull request'), canReview && methods.length > 0, () => this.merge(false))], [this.action('autoMerge', localize('github.editor.autoMerge', 'Enable auto-merge'), canReview && !!info?.allowAutoMerge && methods.length > 0 && !model.pullRequest?.autoMerge, () => this.merge(true))]);
		const interactionState = `${model.busy}/${model.submissionUncertain}`;
		if (this.shownThreads !== model.threads || this.shownReviews !== model.reviews || this.shownComments !== model.pullRequestComments || this.threadInteractionState !== interactionState) {
			this.threadInteractionState = interactionState;
			this.shownThreads = model.threads; this.shownReviews = model.reviews; this.shownComments = model.pullRequestComments; this.threadResources.clear(); this.discussions.replaceChildren(h(this.root.ownerDocument, 'h3', localize('github.editor.discussions', 'Review discussions')));
			for (const comment of model.pullRequestComments) { const row = this.element(this.discussions, 'github-pr-comment'); this.link(row, localize('github.editor.prComment', 'PR comment #{0}', comment.id), comment.url); row.append(h(this.root.ownerDocument, 'pre', comment.body)); }
			for (const review of model.reviews) { const row = this.element(this.discussions, 'github-thread'); this.link(row, review.state, review.url); row.append(h(this.root.ownerDocument, 'p', localize('github.editor.reviewCommit', 'Reviewed commit: {0}', review.commit)), h(this.root.ownerDocument, 'pre', review.body)); }
			for (const thread of model.threads) { this.renderThread(thread); }
		}
		for (const input of this.discussions.querySelectorAll<HTMLInputElement>('input')) { input.disabled = model.busy || model.submissionUncertain; }
		this.discussionActions.setActions([
			this.action('morePRComments', localize('github.editor.morePRComments', 'Load more PR comments'), !model.busy && model.nextCommentsPage !== null, () => model.morePullRequestComments()),
			this.action('moreThreads', localize('github.editor.moreThreads', 'Load more discussions'), !model.busy && !!model.nextThreadsCursor, () => model.moreThreads()),
			this.action('moreReviews', localize('github.editor.moreReviews', 'Load more reviews'), !model.busy && model.nextReviewsPage !== null, () => model.moreReviews()),
		]);
	}

	private renderThread(thread: GitHubReviewThread): void {
		const row = this.element(this.discussions, 'github-thread'); row.dataset.threadId = thread.id;
		row.append(h(this.root.ownerDocument, 'strong', `${thread.path}:${thread.line ?? ''}`), h(this.root.ownerDocument, 'p', thread.outdated ? localize('github.editor.outdated', 'Outdated') : thread.resolved ? localize('github.editor.resolved', 'Resolved') : localize('github.editor.unresolved', 'Unresolved')));
		for (const comment of thread.comments.comments) {
			const item = this.element(row, 'github-review-comment');
			this.link(item, comment.author ?? localize('github.editor.deletedAuthor', 'Deleted account'), comment.url); item.append(h(this.root.ownerDocument, 'pre', comment.body));
			const actions = this.toolbar(item, localize('github.editor.commentActions', 'Comment actions'), this.threadResources);
			actions.setActions([
				this.action(`editComment-${comment.id}`, localize('github.editor.editComment', 'Edit review comment'), comment.canUpdate && !this.model.busy && !this.model.submissionUncertain, async () => {
					const selection = this.selection();
					const result = await this.dialogs.input({ message: localize('github.editor.editComment', 'Edit review comment'), inputs: [{ value: comment.body }], primaryButton: localize('github.editor.save', 'Save') });
					if (result.confirmed && result.values?.[0]?.trim()) { selection(); await this.model.editReviewComment(thread, comment, result.values[0]); }
				}),
				this.action(`deleteComment-${comment.id}`, localize('github.editor.deleteComment', 'Delete review comment'), comment.canDelete && !this.model.busy && !this.model.submissionUncertain, async () => {
					const selection = this.selection();
					if ((await this.dialogs.confirm({ message: localize('github.editor.deleteCommentConfirm', 'Delete this review comment?'), detail: comment.body })).confirmed) { selection(); await this.model.deleteReviewComment(thread, comment); }
				}),
			]);
		}
		const reply = this.threadResources.add(new InputBox(row, { ariaLabel: localize('github.editor.reply', 'Reply to discussion'), presentation: 'field' }));
		reply.inputElement.dataset.githubFocus = `reply-${thread.id}`; reply.value = this.replies.get(thread.id) ?? '';
		this.threadResources.add(reply.onDidChange(value => this.replies.set(thread.id, value)));
		const actions = this.toolbar(row, localize('github.editor.threadActions', 'Discussion actions'), this.threadResources);
		actions.setActions([
			this.action(`reply-${thread.id}`, localize('github.editor.sendReply', 'Send reply'), !this.model.busy && !this.model.submissionUncertain, async () => {
				if (this.model.busy || this.model.submissionUncertain || !reply.value.trim()) { return; }
				await this.model.reply(thread, reply.value);
				if (!this.model.error) { this.replies.delete(thread.id); const current = [...this.discussions.querySelectorAll<HTMLInputElement>('input')].find(input => input.dataset.githubFocus === `reply-${thread.id}`); if (current) { current.value = ''; } }
			}),
			this.action(`resolve-${thread.id}`, thread.resolved ? localize('github.editor.unresolve', 'Reopen discussion') : localize('github.editor.resolve', 'Resolve discussion'), thread.canResolve && !this.model.busy && !this.model.submissionUncertain, () => {
				if (!this.model.busy && !this.model.submissionUncertain) { return this.model.resolve(thread, thread.resolved ? GitHubReviewThreadState.Unresolved : GitHubReviewThreadState.Resolved); }
			}),
			this.action(`more-${thread.id}`, localize('github.editor.moreReplies', 'Load more replies'), !this.model.busy && !!thread.comments.nextCursor, () => this.model.moreThreadComments(thread)),
		]);
	}

	private renderIssue(): void {
		this.issueComments.replaceChildren();
		for (const comment of this.model.issue?.comments ?? []) { const row = this.element(this.issueComments, 'github-thread'); this.link(row, localize('github.editor.commentLink', 'Comment #{0}', comment.id), comment.url); row.append(h(this.root.ownerDocument, 'pre', comment.body)); }
		this.issueReply.disabled = !this.model.ready || this.model.busy || this.model.submissionUncertain;
		this.issueActions.setActions([
			this.action('issueReply', localize('github.editor.sendComment', 'Send comment'), this.model.ready && !this.model.busy && !this.model.submissionUncertain, async () => { if (!this.issueReply.value.trim()) { return; } await this.model.commentOnIssue(this.issueReply.value); if (!this.model.error) { this.issueReply.value = ''; } }),
			this.action('moreComments', localize('github.editor.moreComments', 'Load more comments'), !this.model.busy && this.model.nextCommentsPage !== null, () => this.model.moreIssueComments()),
		]);
	}

	private async openFile(): Promise<void> {
		const file = this.model.files.find(item => item.filename === this.files.value);
		const repo = this.model.repository; const pr = this.model.pullRequest; const base = this.model.baseCommit;
		const identity = file && repo && pr && base ? `${this.accountEpoch}/${repo.owner}/${repo.name}/${pr.headCommit}/${base}/${file.filename}` : undefined;
		if (identity === this.diffIdentity) { return; }
		this.diffIdentity = identity; this.selectedFile = file; this.diffCancellation.dispose(true); this.diffCancellation = new CancellationTokenSource(); this.diffSession.clear(); this.diffContainer.replaceChildren();
		this.selectedLine = 1; this.selectedSide = GitHubDiffSide.Right; this.updateInlineActions();
		if (!file || !repo || !pr || !base) { this.diffNotice.textContent = ''; return; }
		const cancellation = this.diffCancellation; const token = cancellation.token;
		const controller = new AbortController(); const resources = new DisposableStore();
		resources.add(token.onCancellationRequested(() => controller.abort()));
		this.diffNotice.textContent = localize('github.editor.loadingDiff', 'Loading file comparison…');
		try {
			const empty: GitHubFileContent = { kind: 'text', text: '' };
			const [before, after] = await Promise.all([
				file.status === 'added' ? Promise.resolve(empty) : this.github.readFile(repo, base, file.previousFilename ?? file.filename, token),
				file.status === 'removed' ? Promise.resolve(empty) : this.github.readFile(repo, pr.headCommit, file.filename, token),
			]);
			if (token.isCancellationRequested) { resources.dispose(); return; }
			if (before.kind !== 'text' || after.kind !== 'text') {
				this.diffNotice.textContent = before.kind === 'tooLarge' || after.kind === 'tooLarge' ? localize('github.editor.largeFile', 'This file exceeds the 1 MB review limit. View it on GitHub.') : localize('github.editor.binaryFile', 'Binary file. View it on GitHub.');
				resources.dispose(); return;
			}
			const uri = (commit: string, path: string) => URI.from({ scheme: 'ash-github-file', authority: repo.host, path: `/${repo.owner}/${repo.name}/${commit}/${path}`, query: `account=${this.accountEpoch}` });
			const original = resources.add(await this.models.acquire({ resource: uri(base, file.previousFilename ?? file.filename), initialText: before.text }, controller.signal));
			const modified = resources.add(await this.models.acquire({ resource: uri(pr.headCommit, file.filename), initialText: after.text }, controller.signal));
			if (token.isCancellationRequested) { resources.dispose(); return; }
			const computation = resources.add(new WorkerDiffComputationService());
			const diff = resources.add(new DiffModel({ original: original.model, modified: modified.model, diffProvider: computation, diffOptions: { ignoreTrimWhitespace: false, maxComputationTimeMs: 5000, computeMoves: false } }));
			const widget = resources.add(this.instantiation.createInstance(DiffEditorWidget, { container: this.diffContainer, model: diff, readOnly: true, originalAriaLabel: localize('github.editor.original', 'Original file'), modifiedAriaLabel: localize('github.editor.modified', 'Modified file') }));
			for (const [editor, side] of [[widget.originalEditor, GitHubDiffSide.Left], [widget.modifiedEditor, GitHubDiffSide.Right]] as const) {
				const select = () => { this.selectedSide = side; this.selectedLine = editor.getPosition()?.lineNumber ?? 1; this.updateInlineActions(); };
				resources.add(editor.onDidFocusEditorText(select)); resources.add(editor.onDidChangeCursorPosition(select));
			}
			this.diffSession.value = resources;
			this.diffNotice.textContent = file.patch ? '' : localize('github.editor.noPatch', 'GitHub did not provide a patch for this file. Line comments are unavailable.');
		} catch (error) { resources.dispose(); if (!token.isCancellationRequested) { this.diffNotice.textContent = githubErrorMessage(error); } }
	}

	private updateInlineActions(): void {
		this.lineLabel.textContent = this.selectedFile ? localize('github.editor.selectedLine', '{0}, {1}, line {2}', this.selectedFile.filename, this.selectedSide === GitHubDiffSide.Left ? localize('github.editor.originalSide', 'original') : localize('github.editor.modifiedSide', 'modified'), this.selectedLine) : '';
		this.inlineActions.setActions([this.action('addLineComment', localize('github.editor.addLineComment', 'Add line comment to review'), this.model.canWrite && isReviewLine(this.selectedFile?.patch, this.selectedLine, this.selectedSide), () => {
			if (!this.selectedFile || !this.inlineBody.value.trim()) { return; }
			this.model.addComment({ path: this.selectedFile.filename, line: this.selectedLine, side: this.selectedSide, body: this.inlineBody.value }); this.inlineBody.value = '';
		})]);
	}

	private async merge(auto: boolean): Promise<void> {
		const method = this.mergeMethod.value as GitHubMergeMethod | undefined;
		const pr = this.model.pullRequest;
		const repositoryKey = this.model.repositoryKey;
		const accountEpoch = this.model.accountEpoch;
		if (!method || !pr) { return; }
		if ((await this.dialogs.confirm({ message: auto ? localize('github.editor.autoMergeConfirm', 'Enable auto-merge for this pull request?') : localize('github.editor.mergeConfirm', 'Merge this pull request?'), detail: `${pr.title}\n${pr.headCommit}`, primaryButton: auto ? localize('github.editor.autoMerge', 'Enable auto-merge') : localize('github.editor.merge', 'Merge pull request') })).confirmed) {
			// The confirmation authorizes the displayed PR and commit, even if another pane changes selection.
			if (this.model.accountEpoch !== accountEpoch || this.model.repositoryKey !== repositoryKey || this.model.pullRequest?.number !== pr.number || this.model.pullRequest.headCommit !== pr.headCommit) { throw new GitHubError(GitHubErrorCode.Conflict); }
			await this.model.merge(method, auto);
		}
	}
	private async load(): Promise<void> { if (this.mode.value === 'notifications') { await this.model.loadNotifications(this.notificationFilter.value as GitHubNotificationFilter); return; } await this.model.loadRepository(this.owner.value, this.repositoryName.value, this.mode.value === 'issues' ? 'issues' : 'pullRequests', this.filter.value === 'closed' ? GitHubIssueState.Closed : GitHubIssueState.Open); }
	private async showForm(kind: 'new' | 'edit'): Promise<void> {
		if (this.model.mode === 'notifications') { return; }
		const repository = this.model.repositoryInfo;
		const repositoryKey = this.model.repositoryKey;
		if (!repository || !repositoryKey) { throw new GitHubError(GitHubErrorCode.InvalidInput); }
		if (this.model.compose && !(await this.dialogs.confirm({ message: localize('github.editor.replaceCompose', 'Discard the unsaved form and start another?') })).confirmed) { return; }
		const selected = this.model.pullRequest ?? this.model.issue;
		this.model.setCompose({ repositoryKey, mode: this.model.mode, number: kind === 'edit' ? selected!.number : null, title: kind === 'edit' ? selected!.title : '', body: kind === 'edit' ? selected!.body : '', head: '', base: repository.defaultBranch, labels: kind === 'edit' ? this.model.issue?.labels.join(', ') ?? '' : '', assignees: kind === 'edit' ? this.model.issue?.assignees.join(', ') ?? '' : '', draft: false });
		this.formTitle.focus();
	}
	private renderFormActions(): void {
		const compose = this.model.compose;
		for (const input of [this.formTitle, this.formHead, this.formBase, this.formLabels, this.formAssignees]) { input.enabled = !this.model.busy && !this.model.submissionUncertain; }
		this.formBody.disabled = this.formDraft.disabled = this.model.busy || this.model.submissionUncertain;
		this.form.hidden = !compose || compose.repositoryKey !== this.model.repositoryKey || compose.mode !== this.model.mode;
		if (compose && this.shownCompose !== compose) {
			this.shownCompose = compose;
			this.formTitle.value = compose.title; this.formBody.value = compose.body; this.formHead.value = compose.head; this.formBase.value = compose.base; this.formLabels.value = compose.labels; this.formAssignees.value = compose.assignees; this.formDraft.checked = compose.draft;
			const pr = compose.mode === 'pullRequests';
			this.formHead.element.parentElement!.hidden = !pr || compose.number !== null; this.formBase.element.parentElement!.hidden = !pr || compose.number !== null; this.formDraft.parentElement!.hidden = !pr || compose.number !== null;
			this.formLabels.element.parentElement!.hidden = pr; this.formAssignees.element.parentElement!.hidden = pr;
			this.formTarget.textContent = compose.number === null ? localize('github.editor.newTarget', 'New item in {0}', compose.repositoryKey) : localize('github.editor.editTarget', 'Editing #{0} in {1}', compose.number, compose.repositoryKey);
		}
		this.formActions.setActions([
			this.action('save', localize('github.editor.save', 'Save'), !this.model.busy && !this.model.submissionUncertain && !!compose && !this.form.hidden, async () => {
				if (!compose) { return; }
				const title = compose.title.trim(); const body = compose.body;
				if (!title) { this.formTitle.focus(); return; }
				const values = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean);
				if (compose.number !== null) { await this.model.updateItem(compose.number, compose.mode, { title, body, ...(compose.mode === 'issues' ? { labels: values(compose.labels), assignees: values(compose.assignees) } : {}) }); }
				else if (compose.mode === 'pullRequests') { await this.model.createPullRequest({ title, body, head: compose.head.trim(), base: compose.base.trim(), draft: compose.draft }); }
				else { await this.model.createIssue({ title, body, labels: values(compose.labels), assignees: values(compose.assignees) }); }
				if (!this.model.error) { this.model.setCompose(undefined); }
			}),
			this.action('cancelForm', localize('github.editor.cancel', 'Cancel'), !this.model.busy, () => this.model.setCompose(undefined)),
		]);
	}

	// A dialog authorizes the item and account that were visible when it opened.
	private selection(): () => void {
		const epoch = this.model.accountEpoch; const repository = this.model.repositoryKey; const number = this.model.pullRequest?.number; const commit = this.model.pullRequest?.headCommit;
		return () => { if (epoch !== this.model.accountEpoch || repository !== this.model.repositoryKey || number !== this.model.pullRequest?.number || commit !== this.model.pullRequest?.headCommit || this.model.busy) { throw new GitHubError(GitHubErrorCode.Conflict); } };
	}
	private updateFilters(): void {
		const notifications = this.mode.value === 'notifications';
		this.owner.element.parentElement!.hidden = this.repositoryName.element.parentElement!.hidden = notifications;
		this.filter.element.hidden = notifications;
		this.notificationFilter.element.hidden = !notifications;
		this.notificationFilter.enabled = !this.model.busy;
	}
	private async connectEnterprise(): Promise<void> {
		const result = await this.dialogs.input({ message: localize('github.editor.enterpriseSignIn', 'Sign in to GitHub Enterprise'), detail: localize('github.editor.enterpriseHelp', 'Enter the Enterprise host configured by your administrator for Ash browser authorization.'), inputs: [{ placeholder: localize('github.editor.host', 'GitHub host'), value: this.model.selectedAccount?.host === 'github.com' ? '' : this.model.selectedAccount?.host ?? '' }], primaryButton: localize('github.editor.signIn', 'Sign in to GitHub') });
		if (result.confirmed && result.values?.[0]) { await this.connection.connect(result.values[0].trim().toLowerCase()); }
	}
	private async createFork(): Promise<void> {
		const selection = this.selection();
		const repository = this.model.repository!;
		const result = await this.dialogs.input({ message: localize('github.editor.fork', 'Create fork'), detail: localize('github.editor.forkHelp', 'Leave the organization empty to create the fork in your selected account. This creates a remote repository.'), inputs: [{ placeholder: localize('github.editor.forkOrganization', 'Organization (optional)'), value: '' }, { placeholder: localize('github.editor.forkName', 'Fork repository name'), value: repository.name }], checkbox: { label: localize('github.editor.defaultBranchOnly', 'Copy only the default branch'), checked: false }, primaryButton: localize('github.editor.fork', 'Create fork') });
		if (!result.confirmed || !result.values?.[1]?.trim()) { return; }
		selection(); await this.model.createFork({ organization: result.values[0]?.trim() || null, name: result.values[1].trim(), branches: result.checkboxChecked ? GitHubForkBranches.Default : GitHubForkBranches.All });
	}
	private async connectToken(): Promise<void> {
		const result = await this.dialogs.input({ message: localize('github.editor.connectToken', 'Connect with token'), detail: localize('github.editor.tokenHelp', 'Enter the GitHub host and a personal access token with access to the repositories you want to review.'), inputs: [{ placeholder: localize('github.editor.host', 'GitHub host'), value: 'github.com' }, { type: 'password', placeholder: localize('github.editor.token', 'Personal access token') }], primaryButton: localize('github.editor.connect', 'Connect') });
		if (result.confirmed && result.values?.[0] && result.values[1]) { await this.model.connectToken(result.values[0].trim(), result.values[1]); }
	}
	private async changeReviewers(change: GitHubReviewerChange): Promise<void> {
		const selection = this.selection();
		const requested = this.model.requestedReviewers;
		const result = await this.dialogs.input({ message: change === GitHubReviewerChange.Request ? localize('github.editor.requestReviewers', 'Request reviewers') : localize('github.editor.removeReviewers', 'Remove reviewers'), inputs: [{ placeholder: localize('github.editor.reviewerUsers', 'User logins, separated by commas'), value: change === GitHubReviewerChange.Remove ? requested.users.join(', ') : '' }, { placeholder: localize('github.editor.reviewerTeams', 'Team slugs, separated by commas'), value: change === GitHubReviewerChange.Remove ? requested.teams.join(', ') : '' }], primaryButton: localize('github.editor.save', 'Save') });
		if (!result.confirmed || !result.values) { return; }
		const values = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean);
		selection(); await this.model.changeReviewers(change, values(result.values[0] ?? ''), values(result.values[1] ?? ''));
	}
	private async localOperation(kind: 'checkout' | 'push'): Promise<void> {
		const selection = this.selection(); const pr = this.model.pullRequest!; const repository = this.model.repository!;
		const repositories = await this.git.listRepositories(); selection();
		if (!repositories.length) { await this.dialogs.info(localize('github.editor.noCheckout', 'Open a folder containing a Git repository first.')); return; }
		const choice = await this.dialogs.prompt({ message: localize('github.editor.chooseCheckout', 'Choose the local repository'), buttons: repositories.map(repository => ({ label: `${repository.label} — ${repository.path}`, run: () => repository })) });
		if (!choice.result) { return; }
		selection(); const local = choice.result;
		const target = kind === 'push' ? pr.headRepository! : `${repository.owner}/${repository.name}`;
		const identity = `${repository.host}/${target}`;
		const graph = await this.git.graph({ limit: 1 }, local.id); selection();
		const remotes = graph.remotes.filter(remote => remote.identity && `${remote.identity.host}/${remote.identity.owner}/${remote.identity.repository}`.toLowerCase() === identity.toLowerCase());
		if (!remotes.length) { await this.dialogs.info(localize('github.editor.remoteRequired', 'Add a Git remote for {0} in Source Control before continuing.', identity)); return; }
		const remoteChoice = await this.dialogs.prompt({ message: localize('github.editor.chooseRemote', 'Choose the Git remote'), buttons: remotes.map(remote => ({ label: remote.name, run: () => remote.name })) });
		if (!remoteChoice.result) { return; }
		selection(); const remote = remoteChoice.result;
		if (kind === 'checkout') {
			const result = await this.dialogs.input({ message: localize('github.editor.checkout', 'Check out pull request'), detail: localize('github.editor.checkoutDetail', 'Create a local branch at the reviewed commit {0}. Commit or stash local changes first.', pr.headCommit), inputs: [{ placeholder: localize('github.editor.localBranch', 'Local branch name'), value: `pr/${pr.number}` }], primaryButton: localize('github.editor.checkout', 'Check out pull request') });
			if (!result.confirmed || !result.values?.[0]?.trim()) { return; }
			selection();
			if (this.workingCopies.getAll().some(copy => copy.isDirty && extUriBiasedIgnorePathCase.isEqualOrParent(copy.resource, local.root))) { await this.dialogs.info(localize('github.editor.saveFiles', 'Save or close unsaved files in this repository before checking out the pull request.')); return; }
			await this.model.runLocalOperation(async () => { await this.git.executeCommand({ kind: 'fetchAndCheckout', remote, remoteIdentity: identity, reference: `refs/pull/${pr.number}/head`, objectId: pr.headCommit, name: result.values![0]!.trim() }, local.id); });
		} else {
			const status = await this.git.status(local.id); selection();
			if (status.head.type !== 'branch') { await this.dialogs.info(localize('github.editor.branchRequired', 'Check out a local branch with commits before pushing.')); return; }
			const head = status.head;
			if (!(await this.dialogs.confirm({ message: localize('github.editor.pushConfirm', 'Push local commit {0} to {1}:{2}?', head.objectId, identity, pr.headBranch), detail: local.path, primaryButton: localize('github.editor.push', 'Push local commits to pull request') })).confirmed) { return; }
			selection(); await this.model.runLocalOperation(async () => { await this.git.executeCommand({ kind: 'pushBranch', remote, remoteIdentity: identity, branch: head.name, name: pr.headBranch, expectedHead: head.objectId }, local.id); });
		}
	}

	private action(id: string, label: string, enabled: boolean, run: () => unknown): IAction {
		return {
			id: `github.${id}`, label, tooltip: label, enabled, run: async () => {
				if (!enabled) { return; }
				try { return await run(); }
				catch (error) { this.status.textContent = githubErrorMessage(error); this.status.classList.add('error'); }
			}
		};
	}
	private toolbar(parent: HTMLElement, ariaLabel: string, resources?: DisposableStore): WorkbenchToolBar { const toolbar = new WorkbenchToolBar(parent, this.contextMenu, { ariaLabel }); return resources ? resources.add(toolbar) : this._register(toolbar); }
	private input(parent: HTMLElement, text: string, focusKey: string): InputBox { const label = this.element(parent, 'github-field', 'label'); label.append(h(parent.ownerDocument, 'span', text)); const input = this._register(new InputBox(label, { presentation: 'field', ariaLabel: text })); input.inputElement.dataset.githubFocus = focusKey; return input; }
	private textarea(parent: HTMLElement, text: string, focusKey: string): HTMLTextAreaElement { const label = this.element(parent, 'github-field', 'label'); label.append(h(parent.ownerDocument, 'span', text)); const area = h(parent.ownerDocument, 'textarea'); area.setAttribute('aria-label', text); area.dataset.githubFocus = focusKey; area.rows = 3; area.maxLength = 65_536; label.append(area); return area; }
	private select(parent: HTMLElement, label: string, options: readonly { value: string; label: string; }[]): SelectBox { return this._register(new SelectBox(parent, { ariaLabel: label, options, presentation: 'field', contextViewProvider: this.contextView })); }
	private element<K extends 'div' | 'label' = 'div'>(parent: HTMLElement, className: string, tag = 'div' as K) { const element = h(parent.ownerDocument, tag); element.className = className; parent.append(element); return element; }
	private link(parent: HTMLElement, text: string, url: string): void {
		// Remote text is rendered as text; URLs go through the shared opener's trust policy.
		const target = URI.parse(url);
		if (target.scheme !== 'https' && target.scheme !== 'http') { parent.append(h(parent.ownerDocument, 'span', text)); return; }
		const link = h(parent.ownerDocument, 'a', text); link.href = url; link.dataset.githubLink = ''; parent.append(link);
	}
}

export function githubErrorMessage(error: unknown): string {
	if (!(error instanceof GitHubError)) { return localize('github.editor.failed', 'Unable to complete the GitHub operation.'); }
	switch (error.code) {
		case GitHubErrorCode.AuthenticationRequired: return localize('github.editor.authentication', 'Sign in to GitHub, then reload the repository.');
		case GitHubErrorCode.PermissionDenied: return localize('github.editor.permission', 'Your GitHub account does not have permission for this operation.');
		case GitHubErrorCode.NotFound: return localize('github.editor.notFound', 'The repository, pull request, issue or file was not found.');
		case GitHubErrorCode.Conflict: return localize('github.editor.conflict', 'The PR changed or GitHub rejected the operation. Refresh the PR before continuing.');
		case GitHubErrorCode.RateLimited: return localize('github.editor.rateLimited', 'GitHub rate limit reached. Wait before reloading.');
		case GitHubErrorCode.InvalidInput: return localize('github.editor.invalidInput', 'Check the repository, branches, comment and selected diff line.');
		case GitHubErrorCode.SubmissionUncertain: return localize('github.editor.uncertain', 'GitHub may have accepted the operation. Verify the result on GitHub before starting another operation.');
		case GitHubErrorCode.Unavailable: return localize('github.editor.unavailable', 'GitHub is unavailable. Connect to App Server and reload the repository.');
		case GitHubErrorCode.TimedOut: return localize('github.editor.timedOut', 'GitHub timed out. Reload to check the current state.');
		default: return localize('github.editor.failed', 'Unable to complete the GitHub operation.');
	}
}
