import type { ISessionGroupsService } from '../../../services/sessions/browser/sessionGroupsService.js';
import "./media/sessionsControls.css";
import "./media/sessionsList.css";
import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { AbstractDisposable, DisposableMap, toDisposable } from "../../../../base/common/lifecycle.js";
import { DomWidget } from '../../../../platform/domWidget/browser/domWidget.js';
import type { ISessionsService } from "../../../services/sessions/browser/sessionsService.js";
import type { ISessionsManagementService } from "../../../services/sessions/common/sessionsManagement.js";
import type { IGitHubService } from '../../../contrib/github/browser/githubService.js';
import { getPullRequestLabel } from '../../../contrib/github/common/types.js';
import { getHighestPriorityPullRequestIcon } from '../../../../workbench/common/chatPullRequest.js';
import { sessionManagementLabel } from '../../sessionManagementLabels.js';
import type { SessionManagementInfo } from '../../../services/sessions/common/session.js';
import type { ThemeIcon } from '../../../../base/common/themables.js';
import { colorCssVariable } from '../../../../platform/theme/common/colorUtils.js';

/** Session picker owned by the dedicated Sessions Workbench sidebar. */
export class SessionsList extends DomWidget {
	readonly domNode: HTMLElement;
	private readonly heading: HTMLHeadingElement;
	private readonly newSessionButton: HTMLButtonElement;
	private readonly searchInput: HTMLInputElement;
	private readonly list: HTMLDivElement;
	private readonly items = this._register(new DisposableMap<string, SessionListItem>());
	private readonly sectionHeadings = new Map<string, HTMLHeadingElement>();
	private readonly empty: HTMLParagraphElement;
	private readonly sessionService: ISessionsManagementService;
	private readonly viewService: ISessionsService;

	public get element(): HTMLElement { return this.domNode; }

	constructor(container: HTMLElement, sessionService: ISessionsManagementService, viewService: ISessionsService, title: string, newSessionLabel: string, private readonly github: IGitHubService, private readonly groups?: ISessionGroupsService) {
		super();
		const ownerDocument = container.ownerDocument;
		this.sessionService = sessionService;
		this.viewService = viewService;
		this.domNode = h(ownerDocument, "section");
		this.domNode.className = "ash-sessions-list";
		this.heading = h(ownerDocument, "h2");
		this.heading.textContent = title;
		const controls = h(ownerDocument, 'div');
		controls.className = 'ash-sessions-list-controls';
		const search = h(ownerDocument, 'label');
		search.className = 'ash-sessions-list-search';
		appendIcon(Lxicon.search, search);
		this.searchInput = h(ownerDocument, 'input');
		this.searchInput.type = 'search';
		this.searchInput.placeholder = localize('sessions.list.search', 'Search sessions');
		this.searchInput.setAttribute('aria-label', this.searchInput.placeholder);
		search.append(this.searchInput);
		this.newSessionButton = h(ownerDocument, "button");
		this.newSessionButton.type = "button";
		this.newSessionButton.className = 'ash-sessions-list-add';
		this.newSessionButton.setAttribute('aria-label', newSessionLabel);
		this.newSessionButton.title = newSessionLabel;
		appendIcon(Lxicon.add, this.newSessionButton);
		controls.append(search, this.newSessionButton);
		this.list = h(ownerDocument, "div");
		this.list.className = "ash-sessions-list-items";
		this.empty = h(ownerDocument, "p");
		this.empty.className = "ash-sessions-empty";
		this.domNode.append(this.heading, controls, this.list);
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(addDisposableListener(this.newSessionButton, "click", () => viewService.openNewSession(newSessionLabel)));
		this._register(addDisposableListener(this.searchInput, 'input', () => this.render()));
		this._register(viewService.onDidChange(() => this.render()));
		this._register(github.onDidChange(() => this.render()));
		if (groups) this._register(groups.onDidChange(() => this.render()));
		this.render();
	}

	focus(): void {
		const firstItem = this.list.querySelector<HTMLButtonElement>("button");
		if (firstItem) firstItem.focus();
		else this.newSessionButton.focus();
	}

	public getViewState(): { readonly query: string; readonly top: number; readonly focus: string | undefined; } {
		const active = this.domNode.ownerDocument.activeElement;
		const item = [...this.items].find(([, item]) => item.domNode === active);
		const focus = active === this.searchInput ? 'search' : active === this.newSessionButton ? 'new' : item?.[0];
		return { query: this.searchInput.value, top: this.list.scrollTop, focus };
	}

	public restoreViewState(state: ReturnType<SessionsList['getViewState']>): void {
		this.searchInput.value = state.query;
		this.render();
		this.list.scrollTop = state.top;
		if (state.focus === 'search') this.searchInput.focus({ preventScroll: true });
		else if (state.focus === 'new') this.newSessionButton.focus({ preventScroll: true });
		else if (state.focus) this.items.get(state.focus)?.domNode.focus({ preventScroll: true });
	}

	private render(): void {
		const ownerDocument = this.domNode.ownerDocument;
		const ordered: HTMLElement[] = [];
		const grouped = new Map<string, HTMLElement>();
		const present = new Set<string>();
		const activeSelection = this.viewService.activeSelection;
		const query = this.searchInput.value.trim().toLocaleLowerCase();
		for (const selection of this.viewService.visibleSelections) {
			if (selection.kind !== "untitled") continue;
			const session = selection.session;
			if (query && !session.title.toLocaleLowerCase().includes(query)) continue;
			const selected = activeSelection?.kind === "untitled" && activeSelection.session.untitledSessionId === session.untitledSessionId;
			const key = `untitled:${session.untitledSessionId}`;
			const item = this.items.get(key) ?? this.items.set(key, new SessionListItem(ownerDocument));
			item.update(session.title || "New Session", selected, () => this.viewService.openUntitledSession(session.untitledSessionId));
			ordered.push(item.domNode);
			present.add(key);
		}
		for (const session of this.sessionService.sessions) {
			if (query && !session.title.toLocaleLowerCase().includes(query)) continue;
			const current = activeSelection?.kind === "session" && activeSelection.active.session.sessionId === session.sessionId ? activeSelection.active : undefined;
			const thread = current
				? session.chats.find(candidate => candidate.threadId === current.threadId && candidate.status === "active")
				: session.chats.find(candidate => candidate.status === "active" && candidate.origin.type === "root") ?? session.chats.find(candidate => candidate.status === "active");
			if (!thread || session.status !== "active") continue;
			const key = `session:${session.sessionId}`;
			const item = this.items.get(key) ?? this.items.set(key, new SessionListItem(ownerDocument));
			item.update(session.title || "Untitled Session", current !== undefined, () => this.viewService.openSession(session.sessionId, thread.threadId), session.management);
			const requests = this.github.getSessionPullRequests(session.sessionId);
			item.updatePullRequests(getHighestPriorityPullRequestIcon(requests.map(request => request.icon)), requests.map(getPullRequestLabel).join('\n'));
			grouped.set(session.sessionId, item.domNode);
			present.add(key);
		}
		for (const group of this.groups?.groups ?? []) {
			const members = group.sessionIds.filter(id => grouped.has(id));
			if (query && !members.length && !group.name.toLocaleLowerCase().includes(query)) continue;
			const heading = this.sectionHeadings.get(group.sectionId) ?? h(ownerDocument, 'h3');
			this.sectionHeadings.set(group.sectionId, heading);
			heading.textContent = group.name;
			ordered.push(heading);
			for (const id of members) { ordered.push(grouped.get(id)!); grouped.delete(id); }
		}
		ordered.push(...grouped.values());
		for (const id of this.sectionHeadings.keys()) {
			if (!this.groups?.groups.some(group => group.sectionId === id)) this.sectionHeadings.delete(id);
		}
		for (const key of this.items.keys()) {
			if (!present.has(key)) this.items.deleteAndDispose(key);
		}
		if (ordered.length === 0) {
			this.empty.textContent = query ? localize('sessions.list.noResults', 'No matching sessions') : this.sessionService.state === "loading"
				? "Loading sessions…"
				: this.sessionService.error ?? "Create a session to begin.";
			if (this.list.firstChild !== this.empty) this.list.replaceChildren(this.empty);
			return;
		}
		for (let index = 0; index < ordered.length; index++) {
			const button = ordered[index];
			if (this.list.childNodes[index] !== button) this.list.insertBefore(button, this.list.childNodes[index] ?? null);
		}
		while (this.list.childNodes.length > ordered.length) this.list.removeChild(this.list.lastChild!);
	}
}

class SessionListItem extends AbstractDisposable {
	readonly domNode: HTMLButtonElement;
	private readonly label: HTMLSpanElement;
	private readonly pullRequest: HTMLSpanElement;
	private readonly management: HTMLSpanElement;
	private managementDescription: string | undefined;
	private pullRequestDescription = '';
	private open: () => void = () => { };
	private readonly clickListener;

	constructor(ownerDocument: Document) {
		super();
		this.domNode = h(ownerDocument, "button");
		this.domNode.type = "button";
		this.domNode.className = "ash-sessions-list-item";
		const avatar = h(ownerDocument, 'span');
		avatar.className = 'ash-sessions-list-avatar';
		avatar.setAttribute('aria-hidden', 'true');
		appendIcon(Lxicon.chat4, avatar);
		this.label = h(ownerDocument, 'span');
		this.label.className = 'ash-sessions-list-label';
		this.management = h(ownerDocument, 'span');
		this.management.className = 'ash-sessions-list-management';
		this.management.hidden = true;
		this.management.setAttribute('aria-live', 'polite');
		const content = h(ownerDocument, 'span');
		content.className = 'ash-sessions-list-content';
		content.append(this.label, this.management);
		this.pullRequest = h(ownerDocument, 'span');
		this.pullRequest.className = 'ash-sessions-list-pr';
		this.pullRequest.setAttribute('aria-hidden', 'true');
		this.pullRequest.hidden = true;
		this.domNode.append(avatar, content, this.pullRequest);
		this.clickListener = addDisposableListener(this.domNode, "click", () => this.open());
	}

	update(title: string, selected: boolean, open: () => void, management?: SessionManagementInfo): void {
		if (this.label.textContent !== title) this.label.textContent = title;
		const state = sessionManagementLabel(management);
		if (this.management.textContent !== (state ?? '')) this.management.textContent = state ?? '';
		this.management.hidden = state === undefined;
		this.managementDescription = [state, management?.activity?.text, management?.summary].filter(Boolean).join('. ');
		this.updateDescription();
		this.domNode.classList.toggle("selected", selected);
		this.domNode.setAttribute("aria-current", selected ? "page" : "false");
		this.open = open;
	}

	updatePullRequests(icon: ThemeIcon | undefined, description: string): void {
		this.pullRequest.replaceChildren();
		this.pullRequest.hidden = icon === undefined;
		if (icon) {
			appendIcon(icon, this.pullRequest);
			this.pullRequest.style.color = `var(${colorCssVariable(icon.color!.id)})`;
		}
		this.pullRequestDescription = description;
		this.updateDescription();
	}

	private updateDescription(): void {
		const parts = [this.label.textContent, this.managementDescription, this.pullRequestDescription].filter(Boolean);
		this.domNode.title = parts.join('\n');
		this.domNode.setAttribute('aria-label', parts.join('. '));
	}

	protected override disposeCore(): void {
		this.clickListener.dispose();
		this.domNode.remove();
	}
}
