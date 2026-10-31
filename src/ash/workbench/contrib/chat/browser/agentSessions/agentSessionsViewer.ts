import './media/agentsessionsviewer.css';
import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import type { ContextMenuAnchor } from '../../../../../base/browser/contextmenu.js';
import type { AsyncTreeDataSource } from '../../../../../base/browser/ui/tree/tree.js';
import { getNLSLanguage, localize } from '../../../../../nls.js';
import { isAgentSessionSection, type AgentSessionListItem, type IAgentSessionListItem, type IAgentSessionsModel, type IAgentSessionSection } from './agentSessionsModel.js';

/** Formats a provider's per-chat timestamp without assigning a time to unknown activity. */
export function sessionDateFromNow(sessionTime: number, appendAgoLabel = false): string {
	const elapsed = Math.max(0, Date.now() - sessionTime);
	if (elapsed < 60_000) return localize('sessions.history.now', 'now');
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const date = new Date(sessionTime);
	const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	// Calendar days keep "yesterday" stable across midnight and daylight-saving changes.
	const calendarDays = Math.round((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(day.getFullYear(), day.getMonth(), day.getDate())) / 86_400_000);
	const unit = calendarDays > 0 ? 'day' : elapsed >= 3_600_000 ? 'hour' : 'minute';
	const amount = calendarDays > 0 ? calendarDays : Math.floor(elapsed / (unit === 'hour' ? 3_600_000 : 60_000));
	if (appendAgoLabel && unit === 'minute') return localize('sessions.history.minutesAgo', '{0} min ago', amount);
	if (appendAgoLabel) return new Intl.RelativeTimeFormat(getNLSLanguage(), { numeric: 'auto', style: 'short' }).format(-amount, unit);
	return new Intl.NumberFormat(getNLSLanguage(), { style: 'unit', unit, unitDisplay: 'short' }).format(amount);
}

export function agentSessionSectionId(item: IAgentSessionListItem): string {
	if (item.pinned) return 'pinned';
	if (item.kind === 'draft') return 'drafts';
	return item.group ? `group:${item.group.sectionId}` : 'sessions';
}

/** Groups the current model snapshot without owning session or selection state. */
export class AgentSessionsDataSource implements AsyncTreeDataSource<IAgentSessionsModel, AgentSessionListItem> {
	constructor(private readonly query: () => string) { }

	public hasChildren(element: IAgentSessionsModel | AgentSessionListItem): boolean {
		return !('kind' in element) || isAgentSessionSection(element);
	}

	public getChildren(element: IAgentSessionsModel | AgentSessionListItem): Iterable<AgentSessionListItem> {
		if ('kind' in element) return isAgentSessionSection(element) ? element.items : [];
		const query = this.query().trim().toLocaleLowerCase();
		const groups = new Map<string, { label: string; items: IAgentSessionListItem[]; }>();
		for (const item of element.items) {
			if (query && !item.title.toLocaleLowerCase().includes(query) && !item.description.toLocaleLowerCase().includes(query)) continue;
			const id = agentSessionSectionId(item);
			const label = item.pinned ? localize('sessions.list.pinned', 'Pinned') : item.kind === 'draft' ? localize('chat.sessions.drafts', 'Drafts') : item.group?.name ?? localize('chat.sessions.sessions', 'Sessions');
			if (!groups.has(id)) groups.set(id, { label, items: [] });
			groups.get(id)!.items.push(item);
		}
		return [...groups].sort(([a], [b]) => Number(b === 'pinned') - Number(a === 'pinned'))
			.map(([id, group]): IAgentSessionSection => ({ kind: 'section', id, ...group }));
	}
}

/** Owns only rendered row resources; the shared Tree owns their placement and navigation. */
export class AgentSessionRenderer extends Disposable {
	private readonly rows = this._register(new DisposableMap<HTMLElement, AgentSessionRow>());
	private readonly menuRequested = this._register(new Emitter<{ readonly item: IAgentSessionListItem; readonly anchor: ContextMenuAnchor; onHide(): void; }>());
	public readonly onDidRequestContextMenu = this.menuRequested.event;
	private readonly rowRemoved = this._register(new Emitter<string>());
	public readonly onDidRemoveSession = this.rowRemoved.event;

	constructor(private readonly document: Document, private readonly focusedSessionId: () => string | undefined) { super(); }

	public render(item: AgentSessionListItem): HTMLElement {
		if (isAgentSessionSection(item)) {
			const heading = h(this.document, 'h3');
			heading.className = 'ash-agent-sessions-group';
			heading.dataset.section = item.id;
			heading.textContent = item.label;
			return heading;
		}
		const row = new AgentSessionRow(this.document, event => this.menuRequested.fire(event));
		row.update(item);
		row.setTabbable(this.focusedSessionId() === item.id);
		this.rows.set(row.domNode, row);
		return row.domNode;
	}

	public updateFocus(): void {
		const id = this.focusedSessionId();
		for (const [, row] of this.rows) {
			row.setTabbable(row.id === id);
		}
	}

	public releaseRow(row: HTMLElement): void {
		const content = row.querySelector<HTMLElement>('.ash-agent-session-item');
		if (content) {
			const id = content.dataset.item!;
			this.rows.deleteAndDispose(content);
			this.rowRemoved.fire(id);
		}
	}
}

class AgentSessionRow extends Disposable {
	readonly domNode: HTMLDivElement;
	private readonly button: HTMLDivElement;
	private readonly title: HTMLSpanElement;
	private readonly description: HTMLSpanElement;
	private item: IAgentSessionListItem | undefined;
	private readonly more: Button;

	constructor(document: Document, showMenu: (event: { item: IAgentSessionListItem; anchor: ContextMenuAnchor; onHide(): void; }) => void) {
		super();
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-agent-session-item';
		this.button = h(document, 'div');
		this.button.className = 'ash-agent-session-row';
		this.title = h(document, 'span');
		this.title.className = 'ash-agent-session-title';
		this.description = h(document, 'span');
		this.description.className = 'ash-agent-session-description';
		this.button.append(this.title, this.description);
		this.domNode.append(this.button);
		const openMenu = (anchor: ContextMenuAnchor) => {
			if (!this.item) return;
			this.domNode.classList.add('menu-visible');
			this.more.domNode.setAttribute('aria-expanded', 'true');
			showMenu({
				item: this.item, anchor, onHide: () => {
					this.domNode.classList.remove('menu-visible');
					this.more.domNode.setAttribute('aria-expanded', 'false');
				}
			});
		};
		const actions = h(document, 'div');
		actions.className = 'ash-agent-session-actions';
		this.domNode.append(actions);
		this.more = this._register(new Button(actions, {
			...defaultButtonStyles, buttonSecondaryForeground: 'currentColor', presentation: 'quiet', icon: Lxicon.ellipsis, iconOnly: true,
			label: localize('sessions.list.more', 'More actions'), onClick: event => { event.stopPropagation(); openMenu(this.more.domNode); },
		}));
		this.more.domNode.classList.add('ash-agent-session-more');
		this._register(addDisposableListener(this.more.domNode, 'keydown', event => {
			if (event.key === 'Enter' || event.key === ' ' || event.key.startsWith('Arrow')) event.stopPropagation();
			if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
				event.preventDefault();
				event.stopPropagation();
				openMenu(this.more.domNode);
			}
		}));
		this.more.domNode.setAttribute('aria-haspopup', 'menu');
		this.more.domNode.setAttribute('aria-expanded', 'false');
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public get id(): string { return this.item!.id; }

	public setTabbable(tabbable: boolean): void {
		this.more.domNode.tabIndex = tabbable ? 0 : -1;
	}

	update(item: IAgentSessionListItem): void {
		this.item = item;
		this.domNode.dataset.item = item.id;
		this.title.textContent = item.title;
		this.description.textContent = item.description;
		this.description.hidden = item.description.length === 0;
		this.button.title = item.title;
		if (item.active) this.button.setAttribute('aria-current', 'page');
		else this.button.removeAttribute('aria-current');
	}
}
