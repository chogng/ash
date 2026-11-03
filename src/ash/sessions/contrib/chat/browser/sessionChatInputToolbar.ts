import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { PullRequestFollowUpWidget } from '../../changes/browser/pullRequestFollowUpWidget.js';
import { ArtifactDetailsPanel } from './artifactDetailsPanel.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
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
import { ISessionContext } from '../../../services/sessions/browser/sessionContext.js';
import { localize } from '../../../../nls.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { colorCssVariable } from '../../../../platform/theme/common/colorUtils.js';
import type { ArtifactAction, IArtifactIntegrationBinding } from '../../../../platform/artifactIntegrations/common/artifactIntegration.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { IGitHubService } from '../../github/browser/githubService.js';
import { getIssueLabel, getPullRequestLabel, type IResolvedSessionIssue, type IResolvedSessionPullRequest } from '../../github/common/types.js';
import { chatInputStackSlotClass, ChatInputStackSlot, setChatInputStackSlot } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputStack.js';

/** Shows durable Issue associations and PRs resolved for the active Session. */
export class SessionChatInputToolbar extends Disposable {
	public readonly element: HTMLDivElement;
	private readonly entries = this._register(new DisposableMap<string, PullRequestEntry>());
	private readonly issuesDomNode: HTMLDivElement;
	private readonly issueSummaryDomNode: HTMLButtonElement;
	private readonly issueIconDomNode: HTMLSpanElement;
	private readonly issueLabelDomNode: HTMLSpanElement;
	private readonly issueListDomNode: HTMLDivElement;
	private renderedSessionId: string | undefined;
	private readonly issueEntries = this._register(new DisposableMap<string, IssueEntry>());

	constructor(
		container: HTMLElement,
		private readonly focusFallback: () => void,
		@ISessionContext private readonly sessionContext: ISessionContext,
		@IGitHubService private readonly github: IGitHubService,
		@IOpenerService private readonly opener: IOpenerService,
		@INotificationService private readonly notifications: INotificationService,
		@IEditorService private readonly editors: IEditorService,
		@IContextViewService private readonly contextViews: IContextViewService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		this.element = h(container.ownerDocument, 'div');
		this.element.className = `ash-session-chat-input-prs ${chatInputStackSlotClass}`;
		this.element.setAttribute('role', 'group');
		this.element.setAttribute('aria-label', localize('sessions.github.references', 'Session GitHub references'));
		container.append(this.element);
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
		this.element.append(this.issuesDomNode);
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
				const focused = this.element.ownerDocument.activeElement as HTMLElement | null;
				if (!focused || !this.issuesDomNode.contains(focused)) { return undefined; }
				return new AccessibleContentProvider(
					AccessibleViewProviderId.SessionsChat,
					{ type: AccessibleViewType.View },
					() => [this.issueSummaryDomNode.textContent, ...this.github.getSessionIssues(this.sessionContext.sessionId!).map(getIssueLabel)].join('\n'),
					() => { if (focused.isConnected) { focused.focus(); } else { this.focusFallback(); } },
					AccessibilityVerbositySettingId.Chat,
				);
			},
		}));
		this._register(toDisposable(() => {
			setChatInputStackSlot(this.element, ChatInputStackSlot.Empty);
			this.element.remove();
		}));
		this._register(github.onDidChange(() => this.render()));
		this._register(sessionContext.onDidChange(() => this.render()));
		this.render();
	}

	private render(): void {
		const sessionId = this.sessionContext.sessionId;
		const focused = this.element.ownerDocument.activeElement;
		const focusWithin = this.element.contains(focused);
		const sessionChanged = this.renderedSessionId !== sessionId;
		this.renderedSessionId = sessionId;
		if (sessionChanged) {
			this.issueEntries.clearAndDisposeAll();
			this.issueListDomNode.hidden = true;
			this.issueSummaryDomNode.setAttribute('aria-expanded', 'false');
		}
		const requests = sessionId ? this.github.getSessionPullRequests(sessionId) : [];
		const present = new Set<string>();
		for (const request of requests) {
			const key = JSON.stringify([sessionId, request.uri.toString()]);
			present.add(key);
			let entry = this.entries.get(key);
			if (!entry) {
				entry = this.entries.set(key, new PullRequestEntry(this.element, request, this.opener, this.notifications, this.editors, async reference => {
					if (!sessionId) { return; }
					await this.github.detachPullRequest(sessionId, reference);
					if (!this.isDisposed) {
						this.focusFallback();
						status(localize('sessions.github.detached', 'Pull request attachment removed.'));
					}
				}, this.contextViews, (container, binding) => this.instantiation.createInstance(PullRequestFollowUpWidget, container, { sessionId: sessionId!, id: binding.artifact.id }), async (request, select) => {
					if (sessionId) { await this.github.invokePullRequestArtifact(sessionId, request, select); }
				}));
				this.element.insertBefore(entry.containerDomNode, this.issuesDomNode);
			}
			entry.update(request);
		}
		for (const key of this.entries.keys()) {
			if (!present.has(key)) {
				this.entries.deleteAndDispose(key);
			}
		}
		this.renderIssues();
		if (focusWithin && (sessionChanged || !focused?.isConnected && this.element.ownerDocument.activeElement === this.element.ownerDocument.body)) {
			this.focusFallback();
		}
	}

	private renderIssues(reader?: IReader): void {
		const issues = this.sessionContext.sessionId ? this.github.getSessionIssues(this.sessionContext.sessionId, reader) : [];
		const focused = this.element.ownerDocument.activeElement;
		const focusWithin = this.issuesDomNode.contains(focused);
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
					const sessionId = this.sessionContext.sessionId;
					if (!sessionId) { return; }
					await this.github.detachIssue(sessionId, reference);
					if (!this.isDisposed) {
						this.focusFallback();
						status(localize('sessions.github.issueDetached', 'Issue attachment removed.'));
					}
				}));
			}
			entry.update(issue);
		}
		for (const key of this.issueEntries.keys()) {
			if (!present.has(key)) { this.issueEntries.deleteAndDispose(key); }
		}
		if (focusWithin && !issues.length) { this.focusFallback(); }
		else if (focusWithin && !focused?.isConnected) { this.issueSummaryDomNode.focus(); }
		this.updateVisibility();
	}

	private updateVisibility(): void {
		const visible = this.entries.size > 0 || !this.issuesDomNode.hidden;
		this.element.hidden = !visible;
		setChatInputStackSlot(this.element, visible ? ChatInputStackSlot.Standalone : ChatInputStackSlot.Empty);
	}
}

/** Prompts for a durable reference while the originating composer still owns the selection. */
export async function attachSessionGitHubReference(
	kind: 'issue' | 'pullRequest',
	context: Pick<ISessionContext, 'sessionId'>,
	github: IGitHubService,
	quickInput: IQuickInputService,
	signal: AbortSignal,
): Promise<boolean> {
	const sessionId = context.sessionId;
	if (!sessionId) return false;
	if (signal.aborted) return true;

	using cancellation = new CancellationTokenSource();
	using listener = addDisposableListener(signal, 'abort', () => cancellation.cancel());
	const issue = kind === 'issue';
	const url = await quickInput.input(issue
		? { title: localize('sessions.github.attachIssueTitle', 'Attach an issue to this session'), placeHolder: 'https://github.com/owner/repo/issues/123' }
		: { title: localize('sessions.github.attachTitle', 'Attach a pull request to this session'), placeHolder: 'https://github.com/owner/repo/pull/123' },
		cancellation.token);
	if (url === undefined || signal.aborted || context.sessionId !== sessionId) return true;

	if (issue) {
		await github.attachIssue(sessionId, url);
		if (!signal.aborted) status(localize('sessions.github.issueAttached', 'Issue attached.'));
	} else {
		await github.attachPullRequest(sessionId, url);
		if (!signal.aborted) status(localize('sessions.github.attached', 'Pull request attached.'));
	}
	return true;
}

class PullRequestEntry extends Disposable {
	public readonly containerDomNode: HTMLDivElement;
	private readonly domNode: HTMLAnchorElement;
	private readonly iconDomNode: HTMLSpanElement;
	private readonly labelDomNode: HTMLSpanElement;
	private readonly removeDomNode: HTMLButtonElement;
	private readonly actionsDomNode: HTMLButtonElement;
	private readonly artifactDetails: ArtifactDetailsPanel;
	private request: IResolvedSessionPullRequest;

	constructor(
		container: HTMLElement,
		request: IResolvedSessionPullRequest,
		opener: IOpenerService,
		notifications: INotificationService,
		editors: IEditorService,
		detach: (reference: NonNullable<IResolvedSessionPullRequest['recordedReference']>) => Promise<void>,
		contextViews: IContextViewService,
		private readonly renderFollowUp: (container: HTMLElement, binding: IArtifactIntegrationBinding) => Disposable,
		invoke: (request: IResolvedSessionPullRequest, select: (binding: IArtifactIntegrationBinding) => Promise<ArtifactAction | undefined>) => Promise<void>,
	) {
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
		this.removeDomNode = this._register(new Button(this.containerDomNode, {
			...defaultButtonStyles, label: localize('sessions.github.remove', 'Remove'), presentation: 'secondary', size: 'small',
		})).domNode;
		this.removeDomNode.classList.add('ash-session-chat-input-pr-action');
		const reviewDomNode = this._register(new Button(this.containerDomNode, {
			...defaultButtonStyles, label: localize('sessions.github.review', 'Review'), presentation: 'secondary', size: 'small',
		})).domNode;
		reviewDomNode.classList.add('ash-session-chat-input-pr-action');
		reviewDomNode.setAttribute('aria-label', localize('sessions.github.reviewLabel', 'Review pull request {0}/{1} #{2} in Ash', request.owner, request.repo, request.number));
		this._register(addDisposableListener(reviewDomNode, 'click', () => {
			const resource = this.request.uri.with({ scheme: 'ash-github', query: '', fragment: '' });
			void editors.openEditor({ resource, label: getPullRequestLabel(this.request), readOnly: true, showBreadcrumbs: false }).catch(error => notifications.error(error));
		}));
		this.actionsDomNode = this._register(new Button(this.containerDomNode, {
			...defaultButtonStyles, label: localize('sessions.github.artifactActions', 'PR Actions'), presentation: 'secondary', size: 'small',
		})).domNode;
		this.actionsDomNode.classList.add('ash-session-chat-input-pr-action');
		this.artifactDetails = this._register(new ArtifactDetailsPanel(this.actionsDomNode, contextViews));
		this._register(addDisposableListener(this.actionsDomNode, 'click', () => {
			if (this.actionsDomNode.disabled) { return; }
			this.actionsDomNode.disabled = true;
			void invoke(this.request, binding => this.selectAction(binding)).catch(error => notifications.error(error)).finally(() => {
				this.actionsDomNode.disabled = false;
				if (!this.isDisposed && this.actionsDomNode.ownerDocument.activeElement === this.actionsDomNode.ownerDocument.body) {
					(this.actionsDomNode.hidden ? this.domNode : this.actionsDomNode).focus();
				}
			});
		}));
		this.containerDomNode.append(this.domNode, reviewDomNode, this.actionsDomNode, this.removeDomNode);
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

	private async selectAction(binding: IArtifactIntegrationBinding): Promise<ArtifactAction | undefined> {
		if (this.isDisposed || this.actionsDomNode.hidden || this.request.artifact?.id !== binding.artifact.id) return undefined;
		return this.artifactDetails.choose(binding, container => this.renderFollowUp(container, binding));
	}

	public update(request: IResolvedSessionPullRequest): void {
		if (this.request.artifact?.id !== request.artifact?.id) this.artifactDetails.close();
		this.request = request;
		const actionsAvailable = !!request.artifact && request.state === 'open';
		if (!actionsAvailable) {
			if (this.actionsDomNode.ownerDocument.activeElement === this.actionsDomNode) { this.domNode.focus(); }
			this.artifactDetails.close();
		}
		this.actionsDomNode.hidden = !actionsAvailable;
		this.actionsDomNode.setAttribute('aria-label', localize('sessions.github.artifactActionsLabel', 'Pull request actions for {0}/{1} #{2}', request.owner, request.repo, request.number));
		this.removeDomNode.hidden = !request.recordedReference;
		this.removeDomNode.setAttribute('aria-label', request.recordedReference?.isArtifact
			? localize('sessions.github.removeArtifactLabel', 'Remove pull request artifact {0}/{1} #{2}', request.owner, request.repo, request.number)
			: localize('sessions.github.removeLabel', 'Remove attached pull request {0}/{1} #{2}', request.owner, request.repo, request.number));
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
		this.removeDomNode = this._register(new Button(this.domNode, {
			...defaultButtonStyles, label: localize('sessions.github.remove', 'Remove'), presentation: 'secondary', size: 'small',
		})).domNode;
		this.removeDomNode.classList.add('ash-session-chat-input-pr-action');
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
