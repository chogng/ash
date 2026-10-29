import './media/agentsessionsviewer.css';
import { addDisposableListener, h, isHTMLElement } from '../../../../../base/browser/dom.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import type { ContextMenuAnchor } from '../../../../../base/browser/contextmenu.js';
import { localize } from '../../../../../nls.js';
import type { IAgentSessionListItem } from './agentSessionsModel.js';

/** Retains session rows while the catalog or filter changes. */
export class AgentSessionsViewer extends Disposable {
	readonly domNode: HTMLElement;
	private readonly groups = new Map<string, { element: HTMLElement; list: HTMLUListElement; heading: HTMLElement }>();
	private readonly rows = this._register(new DisposableMap<string, AgentSessionRow>());
	private readonly menuRequested = this._register(new Emitter<{ readonly item: IAgentSessionListItem; readonly anchor: ContextMenuAnchor; onHide(): void }>());
	readonly onDidRequestContextMenu = this.menuRequested.event;

	constructor(container: HTMLElement) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-agent-sessions-viewer';

		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(addDisposableListener(this.domNode, 'keydown', event => this.onKeyDown(event)));
	}

	update(items: readonly IAgentSessionListItem[]): number {
		const sections = new Map<string, { label: string; rows: AgentSessionRow[] }>();
		const present = new Set<string>();
		for (const item of items) {
			const row = this.rows.get(item.id) ?? this.rows.set(item.id, new AgentSessionRow(this.domNode.ownerDocument, event => this.menuRequested.fire(event)));
			row.update(item);
			const id = item.pinned ? 'pinned' : item.kind === 'draft' ? 'drafts' : item.group ? `group:${item.group.sectionId}` : 'sessions';
			const label = item.pinned
				? localize('sessions.list.pinned', 'Pinned')
				: item.kind === 'draft'
					? localize('chat.sessions.drafts', 'Drafts')
					: (item.group?.name ?? localize('chat.sessions.sessions', 'Sessions'));
			if (!sections.has(id)) sections.set(id, { label, rows: [] });
			sections.get(id)!.rows.push(row);
			present.add(item.id);
		}
		for (const key of this.rows.keys()) {
			if (!present.has(key)) this.rows.deleteAndDispose(key);
		}
		const ordered = [...sections].sort(([a], [b]) => Number(b === 'pinned') - Number(a === 'pinned'));
		for (const [index, [id, section]] of ordered.entries()) {
			let group = this.groups.get(id);
			if (!group) {
				const element = h(this.domNode.ownerDocument, 'section');
				element.className = 'ash-agent-sessions-group';
				element.dataset.section = id;
				const heading = h(this.domNode.ownerDocument, 'h3');
				const list = h(this.domNode.ownerDocument, 'ul');
				element.append(heading, list);
				this.groups.set(id, (group = { element, heading, list }));
			}
			group.heading.textContent = section.label;
			this.updateList(group.list, section.rows);
			if (this.domNode.children[index] !== group.element) this.domNode.insertBefore(group.element, this.domNode.children[index] ?? null);
		}
		for (const [id, group] of this.groups) {
			if (!sections.has(id)) {
				group.element.remove();
				this.groups.delete(id);
			}
		}
		return items.length;
	}

	focusSelected(): boolean {
		const selected = this.domNode.querySelector<HTMLButtonElement>('.ash-agent-session-row[aria-current="page"]');
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
	private item: IAgentSessionListItem | undefined;
	private readonly more: Button;

	constructor(document: Document, showMenu: (event: { item: IAgentSessionListItem; anchor: ContextMenuAnchor; onHide(): void }) => void) {
		super();
		this.domNode = h(document, 'li');
		this.domNode.className = 'ash-agent-session-item';
		this.button = h(document, 'button');
		this.button.type = 'button';
		this.button.className = 'ash-agent-session-row';
		this.title = h(document, 'span');
		this.title.className = 'ash-agent-session-title';
		this.description = h(document, 'span');
		this.description.className = 'ash-agent-session-description';
		this.button.append(this.title, this.description);
		this.domNode.append(this.button);
		this._register(addDisposableListener(this.button, 'click', () => this.item?.open()));
		const openMenu = (anchor: ContextMenuAnchor) => {
			if (!this.item) return;
			this.domNode.classList.add('menu-visible');
			this.more.domNode.setAttribute('aria-expanded', 'true');
			showMenu({
				item: this.item,
				anchor,
				onHide: () => {
					this.domNode.classList.remove('menu-visible');
					this.more.domNode.setAttribute('aria-expanded', 'false');
				},
			});
		};
		const actions = h(document, 'div');
		actions.className = 'ash-agent-session-actions';
		this.domNode.append(actions);
		this.more = this._register(
			new Button(actions, {
				...defaultButtonStyles,
				presentation: 'quiet',
				icon: Lxicon.ellipsis,
				iconOnly: true,
				label: localize('sessions.list.more', 'More actions'),
				onClick: () => openMenu(this.more.domNode),
			}),
		);
		this.more.domNode.classList.add('ash-agent-session-more');
		this.more.domNode.setAttribute('aria-haspopup', 'menu');
		this.more.domNode.setAttribute('aria-expanded', 'false');
		this._register(
			addDisposableListener(this.button, 'contextmenu', event => {
				event.preventDefault();
				openMenu({ x: event.clientX, y: event.clientY, targetWindow: document.defaultView! });
			}),
		);
		this._register(
			addDisposableListener(this.button, 'keydown', event => {
				if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
					event.preventDefault();
					openMenu(this.button);
				}
			}),
		);
		this._register(toDisposable(() => this.domNode.remove()));
	}

	update(item: IAgentSessionListItem): void {
		this.item = item;
		this.domNode.dataset.item = item.id;
		this.title.textContent = item.title;
		this.description.textContent = item.description;
		this.description.hidden = item.description.length === 0;
		this.button.title = item.title;
		this.button.classList.toggle('selected', item.active);
		if (item.active) this.button.setAttribute('aria-current', 'page');
		else this.button.removeAttribute('aria-current');
	}
}
