import { createUuid } from '../../../../base/common/uuid.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import './media/sessionChatInputToolbar.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { autorun, type IReader } from '../../../../base/common/observable.js';
import { computeAggregateIssueIcon, computeIssueIcon } from '../../../../workbench/common/chatIssue.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../base/common/lifecycle.js';
import type { Event } from '../../../../base/common/event.js';
import { localize } from '../../../../nls.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { colorCssVariable } from '../../../../platform/theme/common/colorUtils.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { IGitHubService } from '../../github/browser/githubService.js';
import { getIssueLabel, getPullRequestLabel, type IResolvedSessionIssue, type IResolvedSessionPullRequest } from '../../github/common/types.js';

/** Shows durable Issue associations and PRs resolved for the active Session. */
export class SessionChatInputToolbar extends Disposable {
	public readonly domNode: HTMLDivElement;
	private readonly entries = this._register(new DisposableMap<string, PullRequestEntry>());
	private readonly attachDomNode: HTMLButtonElement;
	private readonly attachIssueDomNode: HTMLButtonElement;
	private readonly issuesDomNode: HTMLDivElement;
	private readonly issueSummaryDomNode: HTMLButtonElement;
	private readonly issueIconDomNode: HTMLSpanElement;
	private readonly issueLabelDomNode: HTMLSpanElement;
	private readonly issueListDomNode: HTMLDivElement;
	private readonly issueEntries = this._register(new DisposableMap<string, IssueEntry>());

	constructor(
		container: HTMLElement,
		private readonly model: { readonly sessionId: string | undefined; readonly onDidChange: Event<void>; },
		@IGitHubService private readonly github: IGitHubService,
		@IOpenerService private readonly opener: IOpenerService,
		@INotificationService private readonly notifications: INotificationService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IEditorService private readonly editors: IEditorService,
	) {
		super();
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = 'ash-session-chat-input-prs';
		this.domNode.setAttribute('role', 'group');
		this.domNode.setAttribute('aria-label', localize('sessions.github.references', 'Session GitHub references'));
		container.append(this.domNode);
		this.attachDomNode = h(container.ownerDocument, 'button');
		this.attachDomNode.type = 'button';
		this.attachDomNode.className = 'ash-session-chat-input-pr-action';
		this.attachDomNode.textContent = localize('sessions.github.attach', 'Attach PR');
		this.domNode.append(this.attachDomNode);
		this._register(addDisposableListener(this.attachDomNode, 'click', () => { void this.attach().catch(error => this.notifications.error(error)); }));
		this.attachIssueDomNode = h(container.ownerDocument, 'button');
		this.attachIssueDomNode.type = 'button';
		this.attachIssueDomNode.className = 'ash-session-chat-input-pr-action';
		this.attachIssueDomNode.textContent = localize('sessions.github.attachIssue', 'Attach issue');
		this.domNode.append(this.attachIssueDomNode);
		this._register(addDisposableListener(this.attachIssueDomNode, 'click', () => { void this.attachIssue().catch(error => this.notifications.error(error)); }));
		this.issuesDomNode = h(container.ownerDocument, 'div');
		this.issuesDomNode.className = 'ash-session-chat-input-issues';
		this.issuesDomNode.setAttribute('role', 'group');
		this.issuesDomNode.setAttribute('aria-label', localize('sessions.github.issues', 'Session issues'));
		this.issueSummaryDomNode = h(container.ownerDocument, 'button');
		this.issueSummaryDomNode.type = 'button';
		this.issueSummaryDomNode.className = 'ash-session-chat-input-issue-summary';
		this.issueSummaryDomNode.setAttribute('aria-expanded', 'false');
		this.issueIconDomNode = h(container.ownerDocument, 'span');
		this.issueLabelDomNode = h(container.ownerDocument, 'span');
		this.issueSummaryDomNode.append(this.issueIconDomNode, this.issueLabelDomNode);
		this.issueListDomNode = h(container.ownerDocument, 'div');
		this.issueListDomNode.className = 'ash-session-chat-input-issue-list';
		this.issueListDomNode.hidden = true;
		this.issuesDomNode.append(this.issueSummaryDomNode, this.issueListDomNode);
		this.domNode.append(this.issuesDomNode);
		this._register(addDisposableListener(this.issueSummaryDomNode, 'click', () => {
			const expanded = this.issueListDomNode.hidden;
			this.issueListDomNode.hidden = !expanded;
			this.issueSummaryDomNode.setAttribute('aria-expanded', String(expanded));
		}));
		this._register(addDisposableListener(this.issueListDomNode, 'keydown', event => {
			if (event.key === 'Escape') {
				event.stopPropagation();
				this.issueListDomNode.hidden = true;
				this.issueSummaryDomNode.setAttribute('aria-expanded', 'false');
				this.issueSummaryDomNode.focus();
			}
		}));
		this._register(autorun(reader => this.renderIssues(reader)));
		this._register(AccessibleViewRegistry.register({
			name: `sessionIssues-${createUuid()}`, type: AccessibleViewType.View, priority: 95,
			getProvider: () => {
				const focused = this.domNode.ownerDocument.activeElement as HTMLElement | null;
				if (!focused || !this.issuesDomNode.contains(focused)) { return undefined; }
				return new AccessibleContentProvider(
					AccessibleViewProviderId.SessionsChat,
					{ type: AccessibleViewType.View },
					() => [this.issueSummaryDomNode.textContent, ...this.github.getSessionIssues(this.model.sessionId!).map(getIssueLabel)].join('\n'),
					() => { if (focused.isConnected) { focused.focus(); } else { this.attachIssueDomNode.focus(); } },
					AccessibilityVerbositySettingId.Chat,
				);
			},
		}));
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(github.onDidChange(() => this.render()));
		this._register(model.onDidChange(() => this.render()));
	}

	public render(): void {
		const requests = this.model.sessionId ? this.github.getSessionPullRequests(this.model.sessionId) : [];
		const present = new Set<string>();
		for (const request of requests) {
			const key = request.uri.toString();
			present.add(key);
			let entry = this.entries.get(key);
			if (!entry) {
				entry = this.entries.set(key, new PullRequestEntry(this.domNode, request, this.opener, this.notifications, this.editors, async reference => {
					const sessionId = this.model.sessionId;
					if (!sessionId) { return; }
					await this.github.detachPullRequest(sessionId, reference);
					if (!this.isDisposed) {
						this.attachDomNode.focus();
						status(localize('sessions.github.detached', 'Pull request attachment removed.'));
					}
				}));
				this.domNode.insertBefore(entry.containerDomNode, this.attachDomNode);
			}
			entry.update(request);
		}
		for (const key of this.entries.keys()) {
			if (!present.has(key)) {
				this.entries.deleteAndDispose(key);
			}
		}
		this.renderIssues();
		this.domNode.hidden = !this.model.sessionId;
	}

	private renderIssues(reader?: IReader): void {
		const issues = this.model.sessionId ? this.github.getSessionIssues(this.model.sessionId, reader) : [];
		this.issuesDomNode.hidden = issues.length === 0;
		const icon = computeAggregateIssueIcon(issues.map(entry => entry.issue));
		this.issueIconDomNode.replaceChildren();
		appendIcon(icon, this.issueIconDomNode);
		this.issueIconDomNode.style.color = `var(${colorCssVariable(icon.color!.id)})`;
		const unresolved = issues.filter(entry => !entry.issue || !['open', 'closed'].includes(entry.issue.state)).length;
		const open = issues.filter(entry => entry.issue?.state === 'open').length;
		const summary = localize('sessions.github.issueSummary', '{0} issues · {1} open · {2} closed · {3} unavailable', issues.length, open, issues.length - open - unresolved, unresolved);
		this.issueLabelDomNode.textContent = summary;
		this.issueSummaryDomNode.setAttribute('aria-label', summary);
		this.issueSummaryDomNode.title = summary;
		const present = new Set<string>();
		for (const issue of issues) {
			const key = issue.uri.toString();
			present.add(key);
			let entry = this.issueEntries.get(key);
			if (!entry) {
				entry = this.issueEntries.set(key, new IssueEntry(this.issueListDomNode, issue, this.opener, this.notifications, async reference => {
					const sessionId = this.model.sessionId;
					if (!sessionId) { return; }
					await this.github.detachIssue(sessionId, reference);
					if (!this.isDisposed) {
						this.attachIssueDomNode.focus();
						status(localize('sessions.github.issueDetached', 'Issue attachment removed.'));
					}
				}));
			}
			entry.update(issue);
		}
		for (const key of this.issueEntries.keys()) {
			if (!present.has(key)) { this.issueEntries.deleteAndDispose(key); }
		}
	}

	private async attachIssue(): Promise<void> {
		const sessionId = this.model.sessionId;
		if (!sessionId || this.attachIssueDomNode.disabled) { return; }
		this.attachIssueDomNode.disabled = true;
		try {
			const url = await this.quickInput.input({ title: localize('sessions.github.attachIssueTitle', 'Attach an issue to this session'), placeHolder: 'https://github.com/owner/repo/issues/123' });
			if (url === undefined || this.isDisposed || this.model.sessionId !== sessionId) { return; }
			await this.github.attachIssue(sessionId, url);
			status(localize('sessions.github.issueAttached', 'Issue attached.'));
		} finally {
			this.attachIssueDomNode.disabled = false;
			if (!this.isDisposed) { this.attachIssueDomNode.focus(); }
		}
	}

	private async attach(): Promise<void> {
		const sessionId = this.model.sessionId;
		if (!sessionId || this.attachDomNode.disabled) { return; }
		this.attachDomNode.disabled = true;
		try {
			const url = await this.quickInput.input({ title: localize('sessions.github.attachTitle', 'Attach a pull request to this session'), placeHolder: 'https://github.com/owner/repo/pull/123' });
			if (url === undefined || this.isDisposed || this.model.sessionId !== sessionId) { return; }
			await this.github.attachPullRequest(sessionId, url);
			status(localize('sessions.github.attached', 'Pull request attached.'));
		} finally {
			this.attachDomNode.disabled = false;
			if (!this.isDisposed) { this.attachDomNode.focus(); }
		}
	}
}

class PullRequestEntry extends Disposable {
	public readonly containerDomNode: HTMLDivElement;
	private readonly domNode: HTMLAnchorElement;
	private readonly iconDomNode: HTMLSpanElement;
	private readonly labelDomNode: HTMLSpanElement;
	private readonly removeDomNode: HTMLButtonElement;
	private request: IResolvedSessionPullRequest;

	constructor(container: HTMLElement, request: IResolvedSessionPullRequest, opener: IOpenerService, notifications: INotificationService, editors: IEditorService, detach: (reference: NonNullable<IResolvedSessionPullRequest['recordedReference']>) => Promise<void>) {
		super();
		this.request = request;
		this.containerDomNode = h(container.ownerDocument, 'div');
		this.containerDomNode.className = 'ash-session-chat-input-pr-entry';
		this.domNode = h(container.ownerDocument, 'a');
		this.domNode.href = request.uri.toString();
		this.domNode.className = 'ash-session-chat-input-pr';
		this.iconDomNode = h(container.ownerDocument, 'span');
		this.labelDomNode = h(container.ownerDocument, 'span');
		this.labelDomNode.className = 'ash-session-chat-input-pr-label';
		this.domNode.append(this.iconDomNode, this.labelDomNode);
		this.removeDomNode = h(container.ownerDocument, 'button');
		this.removeDomNode.type = 'button';
		this.removeDomNode.className = 'ash-session-chat-input-pr-action';
		this.removeDomNode.textContent = localize('sessions.github.remove', 'Remove');
		const reviewDomNode = h(container.ownerDocument, 'button');
		reviewDomNode.type = 'button'; reviewDomNode.className = 'ash-session-chat-input-pr-action';
		reviewDomNode.textContent = localize('sessions.github.review', 'Review');
		reviewDomNode.setAttribute('aria-label', localize('sessions.github.reviewLabel', 'Review pull request {0}/{1} #{2} in Ash', request.owner, request.repo, request.number));
		this._register(addDisposableListener(reviewDomNode, 'click', () => {
			const resource = this.request.uri.with({ scheme: 'ash-github', query: '', fragment: '' });
			void editors.openEditor({ resource, label: getPullRequestLabel(this.request), readOnly: true, showBreadcrumbs: false }).catch(error => notifications.error(error));
		}));
		this.containerDomNode.append(this.domNode, reviewDomNode, this.removeDomNode);
		container.append(this.containerDomNode);
		this._register(addDisposableListener(this.domNode, 'click', event => {
			event.preventDefault();
			void opener.open(this.request.uri, { openExternal: true }).catch(error => notifications.error(error));
		}));
		this._register(addDisposableListener(this.removeDomNode, 'click', () => {
			const reference = this.request.recordedReference;
			if (!reference || this.removeDomNode.disabled) { return; }
			this.removeDomNode.disabled = true;
			void detach(reference).catch(error => notifications.error(error)).finally(() => { this.removeDomNode.disabled = false; });
		}));
		this._register(toDisposable(() => this.containerDomNode.remove()));
	}

	public update(request: IResolvedSessionPullRequest): void {
		this.request = request;
		this.removeDomNode.hidden = !request.recordedReference;
		this.removeDomNode.setAttribute('aria-label', localize('sessions.github.removeLabel', 'Remove attached pull request {0}/{1} #{2}', request.owner, request.repo, request.number));
		this.iconDomNode.replaceChildren();
		appendIcon(request.icon, this.iconDomNode);
		this.iconDomNode.style.color = `var(${colorCssVariable(request.icon.color!.id)})`;
		this.labelDomNode.textContent = `${request.repo} #${request.number}`;
		const label = getPullRequestLabel(request);
		this.domNode.title = label;
		this.domNode.setAttribute('aria-label', label);
		this.domNode.dataset.githubContent = label;
	}
}

class IssueEntry extends Disposable {
	public readonly domNode: HTMLDivElement;
	private readonly linkDomNode: HTMLAnchorElement;
	private readonly iconDomNode: HTMLSpanElement;
	private readonly labelDomNode: HTMLSpanElement;
	private readonly removeDomNode: HTMLButtonElement;
	private entry: IResolvedSessionIssue;

	constructor(container: HTMLElement, entry: IResolvedSessionIssue, opener: IOpenerService, notifications: INotificationService, detach: (reference: IResolvedSessionIssue['reference']) => Promise<void>) {
		super();
		this.entry = entry;
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = 'ash-session-chat-input-issue-entry';
		this.linkDomNode = h(container.ownerDocument, 'a');
		this.linkDomNode.className = 'ash-session-chat-input-issue';
		this.iconDomNode = h(container.ownerDocument, 'span');
		this.labelDomNode = h(container.ownerDocument, 'span');
		this.labelDomNode.className = 'ash-session-chat-input-issue-label';
		this.linkDomNode.append(this.iconDomNode, this.labelDomNode);
		this.removeDomNode = h(container.ownerDocument, 'button');
		this.removeDomNode.type = 'button';
		this.removeDomNode.className = 'ash-session-chat-input-pr-action';
		this.removeDomNode.textContent = localize('sessions.github.remove', 'Remove');
		this.domNode.append(this.linkDomNode, this.removeDomNode);
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(addDisposableListener(this.linkDomNode, 'click', event => {
			event.preventDefault();
			void opener.open(this.entry.uri, { openExternal: true }).catch(error => notifications.error(error));
		}));
		this._register(addDisposableListener(this.removeDomNode, 'click', () => {
			if (this.removeDomNode.disabled) { return; }
			this.removeDomNode.disabled = true;
			void detach(this.entry.reference).catch(error => notifications.error(error)).finally(() => { this.removeDomNode.disabled = false; });
		}));
	}

	public update(entry: IResolvedSessionIssue): void {
		this.entry = entry;
		const label = getIssueLabel(entry);
		this.linkDomNode.href = entry.uri.toString();
		this.linkDomNode.title = label;
		this.linkDomNode.setAttribute('aria-label', label);
		this.labelDomNode.textContent = label;
		const icon = computeIssueIcon(entry.issue?.state === 'closed' ? 'closed' : 'open', entry.issue?.stateReason);
		this.iconDomNode.replaceChildren();
		appendIcon(icon, this.iconDomNode);
		this.iconDomNode.style.color = `var(${colorCssVariable(icon.color!.id)})`;
		const { repository, number } = entry.reference;
		this.removeDomNode.setAttribute('aria-label', localize('sessions.github.removeIssueLabel', 'Remove attached issue {0}/{1}/{2} #{3}', repository.host, repository.owner, repository.name, number));
	}
}
