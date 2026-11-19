import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { TabList, type TabListItem } from '../../../../base/browser/ui/tablist/tabList.js';
import { ObjectTree } from '../../../../base/browser/ui/tree/objectTree.js';
import type { ObjectTreeElement } from '../../../../base/browser/ui/tree/objectTreeModel.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import type { PdfOutlineEntry, PdfOutlineTarget } from '../../../../platform/pdf/common/pdfService.js';
import { defaultListStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { PdfMinimap } from './pdfMinimap.js';
import './media/pdfNavigationPane.css';

type NavigationTab = 'thumbnails' | 'outline';

interface OutlineNode {
	readonly id: string;
	readonly entry: PdfOutlineEntry;
}

function outlineNodes(entries: readonly PdfOutlineEntry[], prefix = ''): readonly ObjectTreeElement<OutlineNode>[] {
	return entries.map((entry, index) => {
		const id = `${prefix}${index}`;
		return { element: { id, entry }, children: outlineNodes(entry.children, `${id}/`) };
	});
}

/** Navigation scoped to one PDF editor, with thumbnails independent of outline availability. */
export class PdfNavigationPane extends Disposable {
	readonly domNode: HTMLElement;
	readonly minimap: PdfMinimap;
	private readonly tabs: TabList<NavigationTab>;
	private readonly tabItems: readonly TabListItem<NavigationTab>[];
	private readonly outlinePanel: HTMLElement;
	private readonly tree: ObjectTree<OutlineNode>;
	private activeTab: NavigationTab = 'thumbnails';
	private outlineRequest: AbortController | undefined;
	private outlineAvailable: boolean | undefined;
	private page = 0;
	private pageCount = 0;

	constructor(
		document: Document,
		renderThumbnail: (page: number, signal: AbortSignal) => Promise<Uint8Array>,
		private readonly readOutline: (signal: AbortSignal) => Promise<readonly PdfOutlineEntry[]>,
		openPage: (page: number) => void,
		openDestination: (target: PdfOutlineTarget) => void,
		close: () => void,
	) {
		super();
		const id = `pdf-navigation-${createUuid()}`;
		const label = localize('sessions.pdfPreview.pageNavigation', 'PDF page navigation');
		const outlineLabel = localize('sessions.pdfPreview.outlineTab', 'Outline');
		this.domNode = h(document, 'aside', {
			className: 'ash-sessions-pdf-navigation-pane',
			properties: { id, hidden: true },
			attributes: { 'aria-label': label },
		});
		this.tabs = this._register(new TabList(this.domNode, {
			ariaLabel: label,
			presentation: 'underline',
			onActivate: tab => this.selectTab(tab),
		}));
		this.tabs.setSizing({ mode: 'shrink' });
		this.minimap = this._register(new PdfMinimap(document, renderThumbnail, openPage));
		this.outlinePanel = h(document, 'div', {
			className: 'ash-sessions-pdf-outline',
			attributes: { role: 'tabpanel', 'aria-labelledby': `${id}-outline-tab` },
			properties: { id: `${id}-outline`, hidden: true },
		});
		this.minimap.domNode.id = `${id}-thumbnails`;
		this.tabItems = [
			{ id: 'thumbnails', value: 'thumbnails', label: localize('sessions.pdfPreview.thumbnailsTab', 'Thumbnails'), tabId: `${id}-thumbnails-tab`, panelId: this.minimap.domNode.id },
			{ id: 'outline', value: 'outline', label: outlineLabel, tabId: `${id}-outline-tab`, panelId: this.outlinePanel.id },
		];
		this.domNode.append(this.minimap.domNode, this.outlinePanel);
		this.tree = this._register(new ObjectTree(this.outlinePanel, {
			ariaLabel: outlineLabel,
			styles: defaultListStyles,
			scrolling: 'managed',
			multipleSelectionSupport: false,
			expandOnDoubleClick: false,
			modelOptions: { identityProvider: { getId: node => node.id }, defaultCollapseState: 'expanded' },
			accessibilityProvider: { getAriaLabel: node => node.entry.title },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: node => node.entry.title },
			getHeight: () => 28,
			renderElement: ({ entry }) => h(document, 'span', {
				className: 'ash-sessions-pdf-outline-title',
				properties: { title: entry.title },
			}, entry.title),
		}));
		const activate = ({ id, entry }: OutlineNode) => {
			if (entry.target) { openDestination(entry.target); }
			else { this.tree.toggleCollapsed(id); }
		};
		this._register(this.tree.onPointer(({ element, browserEvent }) => {
			if (browserEvent.button === 0) { activate(element); }
		}));
		this._register(this.tree.onDidAccept(({ element }) => activate(element)));
		this._register(observeResize(this.outlinePanel, () => {
			if (!this.outlinePanel.hidden) { this.tree.layout(this.outlinePanel.clientHeight); }
		}));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) { return; }
			event.preventDefault();
			event.stopPropagation();
			close();
		}));
		this._register(toDisposable(() => this.outlineRequest?.abort()));
		this.selectTab('thumbnails');
	}

	setVisible(visible: boolean): void {
		this.domNode.hidden = !visible;
		this.selectTab(this.activeTab);
		if (visible) { void this.loadOutline(); }
		else { this.page = 0; this.pageCount = 0; }
	}

	setPage(page: number, pageCount: number): void {
		if (this.domNode.hidden) { return; }
		this.page = page;
		this.pageCount = pageCount;
		this.minimap.setPage(page, pageCount);
	}

	resetOutline(): void {
		this.outlineRequest?.abort();
		this.outlineRequest = undefined;
		this.outlineAvailable = undefined;
		this.tree.setChildren([]);
		this.selectTab('thumbnails');
		if (!this.domNode.hidden) { void this.loadOutline(); }
	}

	private selectTab(tab: NavigationTab): void {
		this.activeTab = tab;
		const hasOutline = this.outlineAvailable === true;
		this.domNode.classList.toggle('has-outline', hasOutline);
		this.tabs.element.hidden = !hasOutline;
		this.tabs.setTabs(hasOutline ? this.tabItems : [], hasOutline ? tab : undefined);
		const thumbnailPanel = this.minimap.domNode;
		if (hasOutline) {
			thumbnailPanel.setAttribute('role', 'tabpanel');
			thumbnailPanel.setAttribute('aria-labelledby', this.tabItems[0].tabId);
		} else {
			thumbnailPanel.removeAttribute('role');
			thumbnailPanel.removeAttribute('aria-labelledby');
		}
		this.minimap.setVisible(!this.domNode.hidden && tab === 'thumbnails');
		this.outlinePanel.hidden = this.domNode.hidden || tab !== 'outline';
		if (this.page > 0) { this.minimap.setPage(this.page, this.pageCount); }
	}

	private async loadOutline(): Promise<void> {
		if (this.outlineAvailable !== undefined || this.outlineRequest) { return; }
		const request = new AbortController();
		this.outlineRequest = request;
		try {
			const entries = await this.readOutline(request.signal);
			if (request.signal.aborted) { return; }
			if (entries.length) { this.tree.setChildren(outlineNodes(entries)); }
			this.outlineAvailable = entries.length > 0;
			if (this.outlineAvailable) { this.selectTab(this.activeTab); }
		} catch {
			// The page list stays usable. Reopening the sidebar can retry the request.
		} finally {
			if (this.outlineRequest === request) { this.outlineRequest = undefined; }
		}
	}
}
