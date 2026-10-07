import './media/agentsessionsviewer.css';
import { addDisposableListener, h, isHTMLElement } from '../../../../../base/browser/dom.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import type { IAgentSessionListItem } from './agentSessionsModel.js';

/** Retains session rows while the catalog or filter changes. */
export class AgentSessionsViewer extends Disposable {
	readonly domNode: HTMLElement;
	private readonly draftsList: HTMLUListElement;
	private readonly sessionsList: HTMLUListElement;
	private readonly draftsGroup: HTMLElement;
	private readonly sessionsGroup: HTMLElement;
	private readonly rows = this._register(new DisposableMap<string, AgentSessionRow>());

	constructor(container: HTMLElement) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-agent-sessions-viewer';
		this.draftsGroup = h(document, 'section');
		this.draftsGroup.className = 'ash-agent-sessions-group';
		const draftsHeading = h(document, 'h3');
		draftsHeading.textContent = localize('chat.sessions.drafts', 'Drafts');
		this.draftsList = h(document, 'ul');
		this.draftsGroup.append(draftsHeading, this.draftsList);
		this.sessionsGroup = h(document, 'section');
		this.sessionsGroup.className = 'ash-agent-sessions-group';
		const sessionsHeading = h(document, 'h3');
		sessionsHeading.textContent = localize('chat.sessions.sessions', 'Sessions');
		this.sessionsList = h(document, 'ul');
		this.sessionsGroup.append(sessionsHeading, this.sessionsList);
		this.domNode.append(this.draftsGroup, this.sessionsGroup);
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(addDisposableListener(this.domNode, 'keydown', event => this.onKeyDown(event)));
	}

	update(items: readonly IAgentSessionListItem[]): number {
		const drafts: AgentSessionRow[] = [];
		const sessions: AgentSessionRow[] = [];
		const present = new Set<string>();
		for (const item of items) {
			const row = this.rows.get(item.id) ?? this.rows.set(item.id, new AgentSessionRow(this.domNode.ownerDocument));
			row.update(item);
			(item.kind === 'draft' ? drafts : sessions).push(row);
			present.add(item.id);
		}
		for (const key of this.rows.keys()) {
			if (!present.has(key)) this.rows.deleteAndDispose(key);
		}
		this.updateList(this.draftsList, drafts);
		this.updateList(this.sessionsList, sessions);
		this.draftsGroup.hidden = drafts.length === 0;
		this.sessionsGroup.hidden = sessions.length === 0;
		return items.length;
	}

	focusSelected(): boolean {
		const selected = this.domNode.querySelector<HTMLButtonElement>('button[aria-current="page"]');
		selected?.focus();
		return selected !== null;
	}

	focusFirst(): boolean {
		const first = this.domNode.querySelector<HTMLButtonElement>('.ash-agent-session-row');
		first?.focus();
		return first !== null;
	}

	private onKeyDown(event: KeyboardEvent): void {
		if (!isHTMLElement(event.target) || !event.target.classList.contains('ash-agent-session-row')) return;
		if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
		const buttons = [...this.domNode.querySelectorAll<HTMLButtonElement>('.ash-agent-sessions-group:not([hidden]) .ash-agent-session-row')];
		const index = buttons.indexOf(event.target as HTMLButtonElement);
		if (index < 0) return;
		const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
		buttons[next]?.focus();
		event.preventDefault();
	}

	private updateList(list: HTMLUListElement, rows: readonly AgentSessionRow[]): void {
		for (let index = 0; index < rows.length; index++) {
			const item = rows[index].domNode;
			if (list.children[index] !== item) list.insertBefore(item, list.children[index] ?? null);
		}
	}
}

class AgentSessionRow extends Disposable {
	readonly domNode: HTMLLIElement;
	private readonly button: HTMLButtonElement;
	private readonly title: HTMLSpanElement;
	private readonly description: HTMLSpanElement;
	private open: () => void = () => { };

	constructor(document: Document) {
		super();
		this.domNode = h(document, 'li');
		this.button = h(document, 'button');
		this.button.type = 'button';
		this.button.className = 'ash-agent-session-row';
		this.title = h(document, 'span');
		this.title.className = 'ash-agent-session-title';
		this.description = h(document, 'span');
		this.description.className = 'ash-agent-session-description';
		this.button.append(this.title, this.description);
		this.domNode.append(this.button);
		this._register(addDisposableListener(this.button, 'click', () => this.open()));
		this._register(toDisposable(() => this.domNode.remove()));
	}

	update(item: IAgentSessionListItem): void {
		this.open = item.open;
		this.title.textContent = item.title;
		this.description.textContent = item.description;
		this.description.hidden = item.description.length === 0;
		this.button.title = item.title;
		this.button.classList.toggle('selected', item.active);
		if (item.active) this.button.setAttribute('aria-current', 'page');
		else this.button.removeAttribute('aria-current');
	}
}
