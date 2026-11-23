import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { TabList, type TabListItem } from '../../../../base/browser/ui/tablist/tabList.js';
import { ObjectTree } from '../../../../base/browser/ui/tree/objectTree.js';
import type { ObjectTreeElement } from '../../../../base/browser/ui/tree/objectTreeModel.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
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
	private readonly outlineLabel = localize('sessions.pdfPreview.outlineTab', 'Outline');
	private readonly outlineTree = this._register(new MutableDisposable<DisposableStore>());
	private activeTab: NavigationTab = 'thumbnails';
	private outlineRequest: AbortController | undefined;
	private outlineEntries: readonly PdfOutlineEntry[] | undefined;
	private page = 0;
	private pageCount = 0;

	constructor(
		document: Document,
		renderThumbnail: (page: number, signal: AbortSignal) => Promise<Uint8Array>,
		private readonly readOutline: (signal: AbortSignal) => Promise<readonly PdfOutlineEntry[]>,
		openPage: (page: number) => void,
		private readonly openDestination: (target: PdfOutlineTarget) => void,
		close: () => void,
		private readonly reportError: (message: string) => void,
	) {
		super();
		const id = `pdf-navigation-${createUuid()}`;
		const label = localize('sessions.pdfPreview.pageNavigation', 'PDF page navigation');
		this.domNode = h(document, 'aside', {
			className: 'ash-sessions-pdf-navigation-pane',
			properties: { id, hidden: true },
			attributes: { 'aria-label': label },
		});
		this.tabs = this._register(new TabList(this.domNode, {
			ariaLabel: label,
			presentation: 'navigation',
			onActivate: tab => this.selectTab(tab),
		}));
		const thumbnails = { id: `${id}-thumbnails`, tabId: `${id}-thumbnails-tab` };
		this.minimap = this._register(new PdfMinimap(this.domNode, thumbnails, renderThumbnail, openPage, reportError));
		this.outlinePanel = h(document, 'div', {
			className: 'ash-sessions-pdf-outline',
			attributes: { role: 'tabpanel', 'aria-labelledby': `${id}-outline-tab` },
			properties: { id: `${id}-outline`, hidden: true, tabIndex: 0 },
		});
		this.tabItems = [
			{ id: 'thumbnails', value: 'thumbnails', label: localize('sessions.pdfPreview.thumbnailsTab', 'Thumbnails'), tabId: thumbnails.tabId, panelId: thumbnails.id },
			{ id: 'outline', value: 'outline', label: this.outlineLabel, tabId: `${id}-outline-tab`, panelId: this.outlinePanel.id },
		];
		this.domNode.append(this.outlinePanel);
		this.tabs.setTabs(this.tabItems, this.activeTab);
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) { return; }
			event.preventDefault();
			event.stopPropagation();
			close();
		}));
		this._register(toDisposable(() => this.outlineRequest?.abort()));
	}

	setVisible(visible: boolean): void {
		this.domNode.hidden = !visible;
		if (visible) { this.tabs.setTabs(this.tabItems, this.activeTab); }
		this.updatePanels();
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
		this.outlineEntries = undefined;
		this.outlineTree.clear();
		this.outlinePanel.tabIndex = 0;
		this.selectTab('thumbnails');
		if (!this.domNode.hidden) { void this.loadOutline(); }
	}

	private selectTab(tab: NavigationTab): void {
		if (this.activeTab === tab) { return; }
		this.activeTab = tab;
		this.tabs.setTabs(this.tabItems, tab);
		this.updatePanels();
	}

	private updatePanels(): void {
		this.minimap.setVisible(!this.domNode.hidden && this.activeTab === 'thumbnails');
		this.outlinePanel.hidden = this.domNode.hidden || this.activeTab !== 'outline';
		this.mountOutline();
		if (this.page > 0) { this.minimap.setPage(this.page, this.pageCount); }
	}

	private mountOutline(): void {
		if (this.outlinePanel.hidden || this.outlineTree.value || !this.outlineEntries?.length) { return; }
		const document = this.outlinePanel.ownerDocument;
		const resources = this.outlineTree.value = new DisposableStore();
		const tree = resources.add(new ObjectTree<OutlineNode>(this.outlinePanel, {
			ariaLabel: this.outlineLabel,
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
			if (entry.target) { this.openDestination(entry.target); }
			else { tree.toggleCollapsed(id); }
		};
		resources.add(tree.onPointer(({ element, browserEvent }) => {
			if (browserEvent.button === 0) { activate(element); }
		}));
		resources.add(tree.onDidAccept(({ element }) => activate(element)));
		tree.setChildren(outlineNodes(this.outlineEntries));
		this.outlinePanel.tabIndex = -1;
	}

	private async loadOutline(): Promise<void> {
		if (this.outlineEntries || this.outlineRequest) { return; }
		const request = new AbortController();
		this.outlineRequest = request;
		try {
			const entries = await this.readOutline(request.signal);
			if (request.signal.aborted) { return; }
			this.outlineEntries = entries;
			this.mountOutline();
		} catch (error) {
			// The page list stays usable. Reopening the sidebar can retry the request.
			if (!request.signal.aborted && !this.domNode.hidden && !isCancellationError(error)) {
				this.reportError(localize('sessions.pdfPreview.outlineFailed', 'Could not load the PDF outline: {0}', error instanceof Error ? error.message : String(error)));
			}
		} finally {
			if (this.outlineRequest === request) { this.outlineRequest = undefined; }
		}
	}
}
