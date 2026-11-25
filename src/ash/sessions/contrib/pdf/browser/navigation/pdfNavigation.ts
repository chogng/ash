import { h } from '../../../../../base/browser/dom.js';
import { TabList, type TabListItem } from '../../../../../base/browser/ui/tablist/tabList.js';
import { ObjectTree } from '../../../../../base/browser/ui/tree/objectTree.js';
import type { ObjectTreeElement } from '../../../../../base/browser/ui/tree/objectTreeModel.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import type { PdfOutlineEntry, PdfOutlineTarget } from '../../../../../platform/pdf/common/pdfService.js';
import { defaultListStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import type { PdfDocumentModel } from '../pdfDocumentModel.js';
import { PdfThumbnailList } from './pdfThumbnailList.js';
import type { AuxiliaryBarPart } from '../../../../browser/parts/auxiliaryBarPart.js';
import './media/pdfNavigation.css';

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
export class PdfNavigation extends Disposable {
	readonly thumbnails: PdfThumbnailList;
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
		private readonly pane: AuxiliaryBarPart,
		label: string,
		renderThumbnail: PdfDocumentModel['renderThumbnail'],
		private readonly readOutline: (signal: AbortSignal) => Promise<readonly PdfOutlineEntry[]>,
		openPage: (page: number) => void,
		private readonly openDestination: (target: PdfOutlineTarget) => void,
		private readonly reportError: (message: string) => void,
	) {
		super();
		const container = pane.contentElement;
		const { id, ownerDocument: document } = pane.domNode;
		this.tabs = this._register(new TabList(container, {
			ariaLabel: label,
			presentation: 'navigation',
			onActivate: tab => this.selectTab(tab),
		}));
		this.tabs.setSizing({ mode: 'fixed', minWidth: 0, maxWidth: 96 });
		const thumbnails = { id: `${id}-thumbnails`, tabId: `${id}-thumbnails-tab` };
		this.thumbnails = this._register(new PdfThumbnailList(container, thumbnails, renderThumbnail, openPage, reportError));
		this.outlinePanel = h(document, 'div', {
			className: 'ash-sessions-pdf-outline',
			attributes: { role: 'tabpanel', 'aria-labelledby': `${id}-outline-tab` },
			properties: { id: `${id}-outline`, hidden: true, tabIndex: 0 },
		});
		this.tabItems = [
			{ id: 'thumbnails', value: 'thumbnails', label: localize('sessions.pdfPreview.thumbnailsTab', 'Thumbnails'), tabId: thumbnails.tabId, panelId: thumbnails.id },
			{ id: 'outline', value: 'outline', label: this.outlineLabel, tabId: `${id}-outline-tab`, panelId: this.outlinePanel.id },
		];
		container.append(this.outlinePanel);
		this.tabs.setTabs(this.tabItems, this.activeTab);
		this._register(pane.onDidChangeVisibility(visible => {
			if (visible) { this.tabs.setTabs(this.tabItems, this.activeTab); }
			this.updatePanels();
			if (visible) { void this.loadOutline(); }
			else { this.page = 0; this.pageCount = 0; }
		}));
		this._register(toDisposable(() => this.outlineRequest?.abort()));
	}

	setPage(page: number, pageCount: number): void {
		if (!this.pane.visible) { return; }
		this.page = page;
		this.pageCount = pageCount;
		this.thumbnails.setPage(page, pageCount);
	}

	resetOutline(): void {
		this.outlineRequest?.abort();
		this.outlineRequest = undefined;
		this.outlineEntries = undefined;
		this.outlineTree.clear();
		this.outlinePanel.tabIndex = 0;
		this.selectTab('thumbnails');
		if (this.pane.visible) { void this.loadOutline(); }
	}

	private selectTab(tab: NavigationTab): void {
		if (this.activeTab === tab) { return; }
		this.activeTab = tab;
		this.tabs.setTabs(this.tabItems, tab);
		this.updatePanels();
	}

	private updatePanels(): void {
		this.thumbnails.setVisible(this.pane.visible && this.activeTab === 'thumbnails');
		this.outlinePanel.hidden = !this.pane.visible || this.activeTab !== 'outline';
		this.mountOutline();
		if (this.page > 0) { this.thumbnails.setPage(this.page, this.pageCount); }
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
			if (!request.signal.aborted && this.pane.visible && !isCancellationError(error)) {
				this.reportError(localize('sessions.pdfPreview.outlineFailed', 'Could not load the PDF outline: {0}', error instanceof Error ? error.message : String(error)));
			}
		} finally {
			if (this.outlineRequest === request) { this.outlineRequest = undefined; }
		}
	}
}
