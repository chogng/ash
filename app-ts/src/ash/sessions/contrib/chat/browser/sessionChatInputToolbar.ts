import './media/sessionChatInputToolbar.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../base/common/lifecycle.js';
import type { Event } from '../../../../base/common/event.js';
import { localize } from '../../../../nls.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { colorCssVariable } from '../../../../platform/theme/common/colorUtils.js';
import { IGitHubService } from '../../github/browser/githubService.js';
import { getPullRequestLabel, type IResolvedSessionPullRequest } from '../../github/common/types.js';

/** The composer and sidebar consume the same branch-associated PR state. */
export class SessionChatInputToolbar extends Disposable {
	public readonly domNode: HTMLDivElement;
	private readonly entries = this._register(new DisposableMap<string, PullRequestEntry>());

	constructor(
		container: HTMLElement,
		private readonly model: { readonly sessionId: string | undefined; readonly onDidChange: Event<void>; },
		@IGitHubService private readonly github: IGitHubService,
		@IOpenerService private readonly opener: IOpenerService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = 'ash-session-chat-input-prs';
		this.domNode.setAttribute('role', 'group');
		this.domNode.setAttribute('aria-label', localize('sessions.github.pullRequests', 'Session pull requests'));
		container.append(this.domNode);
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
				entry = this.entries.set(key, new PullRequestEntry(this.domNode, request, this.opener, this.notifications));
			}
			entry.update(request);
		}
		for (const key of this.entries.keys()) {
			if (!present.has(key)) {
				this.entries.deleteAndDispose(key);
			}
		}
		this.domNode.hidden = requests.length === 0;
	}
}

class PullRequestEntry extends Disposable {
	private readonly domNode: HTMLAnchorElement;
	private readonly iconDomNode: HTMLSpanElement;
	private readonly labelDomNode: HTMLSpanElement;

	constructor(container: HTMLElement, request: IResolvedSessionPullRequest, opener: IOpenerService, notifications: INotificationService) {
		super();
		this.domNode = h(container.ownerDocument, 'a');
		this.domNode.href = request.uri.toString();
		this.domNode.className = 'ash-session-chat-input-pr';
		this.iconDomNode = h(container.ownerDocument, 'span');
		this.labelDomNode = h(container.ownerDocument, 'span');
		this.labelDomNode.className = 'ash-session-chat-input-pr-label';
		this.domNode.append(this.iconDomNode, this.labelDomNode);
		container.append(this.domNode);
		this._register(addDisposableListener(this.domNode, 'click', event => {
			event.preventDefault();
			void opener.open(request.uri, { openExternal: true }).catch(error => notifications.error(error));
		}));
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public update(request: IResolvedSessionPullRequest): void {
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
