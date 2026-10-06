import './media/sessionChatInputToolbar.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../base/common/lifecycle.js';
import type { Event } from '../../../../base/common/event.js';
import { localize } from '../../../../nls.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { colorCssVariable } from '../../../../platform/theme/common/colorUtils.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { IGitHubService } from '../../github/browser/githubService.js';
import { getPullRequestLabel, type IResolvedSessionPullRequest } from '../../github/common/types.js';

/** The composer and sidebar consume the same manual and branch-associated PR state. */
export class SessionChatInputToolbar extends Disposable {
	public readonly domNode: HTMLDivElement;
	private readonly entries = this._register(new DisposableMap<string, PullRequestEntry>());
	private readonly attachDomNode: HTMLButtonElement;

	constructor(
		container: HTMLElement,
		private readonly model: { readonly sessionId: string | undefined; readonly onDidChange: Event<void>; },
		@IGitHubService private readonly github: IGitHubService,
		@IOpenerService private readonly opener: IOpenerService,
		@INotificationService private readonly notifications: INotificationService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
	) {
		super();
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = 'ash-session-chat-input-prs';
		this.domNode.setAttribute('role', 'group');
		this.domNode.setAttribute('aria-label', localize('sessions.github.pullRequests', 'Session pull requests'));
		container.append(this.domNode);
		this.attachDomNode = h(container.ownerDocument, 'button');
		this.attachDomNode.type = 'button';
		this.attachDomNode.className = 'ash-session-chat-input-pr-action';
		this.attachDomNode.textContent = localize('sessions.github.attach', 'Attach PR');
		this.domNode.append(this.attachDomNode);
		this._register(addDisposableListener(this.attachDomNode, 'click', () => { void this.attach().catch(error => this.notifications.error(error)); }));
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
				entry = this.entries.set(key, new PullRequestEntry(this.domNode, request, this.opener, this.notifications, async reference => {
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
		this.domNode.hidden = !this.model.sessionId;
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

	constructor(container: HTMLElement, request: IResolvedSessionPullRequest, opener: IOpenerService, notifications: INotificationService, detach: (reference: NonNullable<IResolvedSessionPullRequest['recordedReference']>) => Promise<void>) {
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
		this.containerDomNode.append(this.domNode, this.removeDomNode);
		container.append(this.containerDomNode);
		this._register(addDisposableListener(this.domNode, 'click', event => {
			event.preventDefault();
			void opener.open(request.uri, { openExternal: true }).catch(error => notifications.error(error));
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
