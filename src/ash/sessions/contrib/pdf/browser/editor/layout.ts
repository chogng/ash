import { observeElementSize } from '../../../../../base/browser/observer.js';
import { LayoutPriority, Orientation, SplitView } from '../../../../../base/browser/ui/splitview/splitview.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IViewDescriptorService, WorkbenchViewRegistry } from '../../../../../workbench/common/views.js';
import { ViewDescriptorService } from '../../../../../workbench/services/views/browser/viewDescriptorService.js';
import { AuxiliaryBarPart } from '../../../../browser/parts/auxiliaryBarPart.js';
import './media/layout.css';

const sidebars = {
	left: { index: 0, boundary: 0, defaultWidth: 160, minimumWidth: 96, maximumWidth: 320, key: 'sessions.pdf.layout.navigation.width' },
	right: { index: 2, boundary: 1, defaultWidth: 220, minimumWidth: 104, maximumWidth: 480, key: 'sessions.pdf.layout.annotations.width' },
} as const;
type SidebarSide = keyof typeof sidebars;

export class PdfEditorLayout extends Disposable {
	readonly navigationSidebar: AuxiliaryBarPart;
	readonly annotationSidebar: AuxiliaryBarPart;
	private readonly split: SplitView;
	private width = 0;
	private height = 0;

	constructor(
		private readonly container: HTMLElement,
		readingArea: HTMLElement,
		navigationLabel: string,
		layoutAnnotations: () => void,
		@IInstantiationService instantiation: IInstantiationService,
		@IStorageService private readonly storage: IStorageService,
	) {
		super();
		const scope = this._register(instantiation.createChild());
		// Keep document-local Parts out of the window's view catalog.
		const registry = this._register(new WorkbenchViewRegistry({ registerActions: false }));
		scope.registerInstance(IViewDescriptorService, this._register(scope.createInstance(ViewDescriptorService, {
			registry,
			customizationsStorageKey: 'sessions.pdf.views',
		})));
		this.navigationSidebar = this._register(scope.createInstance(AuxiliaryBarPart, container, { side: 'left' }));
		this.navigationSidebar.domNode.setAttribute('aria-label', navigationLabel);
		this.navigationSidebar.contentElement.classList.add('ash-sessions-pdf-navigation-pane');
		this.annotationSidebar = this._register(scope.createInstance(AuxiliaryBarPart, container, { side: 'right' }));
		this.annotationSidebar.domNode.setAttribute('aria-label', localize('sessions.pdfPreview.annotations', 'PDF annotations'));
		this.annotationSidebar.contentElement.classList.add('ash-sessions-pdf-annotation-panel');
		this.split = this._register(new SplitView(container, {
			orientation: Orientation.HORIZONTAL,
			proportionalLayout: false,
			styles: { separatorBorder: 'var(--ash-contrastBorder, var(--ash-border))' },
		}));
		const layout = this;
		this.addSidebar('left', this.navigationSidebar);
		this.split.addView({
			element: readingArea,
			get minimumSize() { return Math.min(160, Math.floor(layout.width / 2)); },
			maximumSize: Infinity,
			priority: LayoutPriority.High,
			layout: () => { },
		}, 0);
		this.addSidebar('right', this.annotationSidebar, layoutAnnotations);
		this.split.getSash(sidebars.left.boundary)?.element.setAttribute('aria-label', localize('sessions.pdfPreview.resizeNavigation', 'Resize PDF page navigation'));
		this.split.getSash(sidebars.right.boundary)?.element.setAttribute('aria-label', localize('sessions.pdfPreview.resizeAnnotations', 'Resize PDF reading area and annotations'));
		this._register(this.split.onDidSashChangePreferredSize(index => {
			const sidebar = Object.values(sidebars).find(sidebar => sidebar.index === index);
			const width = this.split.getViewLayoutSize(index);
			if (sidebar && width > 0) this.storage.store(sidebar.key, width, StorageScope.PROFILE, StorageTarget.MACHINE);
		}));
		this._register(this.split.onDidSashReset(boundary => {
			const sidebar = Object.values(sidebars).find(sidebar => sidebar.boundary === boundary);
			if (!sidebar) return;
			this.split.resizeView(sidebar.index, sidebar.defaultWidth);
			this.storage.remove(sidebar.key, StorageScope.PROFILE);
		}));
		this._register(observeElementSize(container, () => this.layout()));
	}

	setSideVisible(side: SidebarSide, visible: boolean): void {
		this.split.setViewVisible(sidebars[side].index, visible);
	}

	layout(): void {
		const { clientWidth: width, clientHeight: height } = this.container;
		// Keep the last split sizes while hidden, but expose a zero-sized reading viewport.
		this.split.element.hidden = !width || !height;
		if (this.split.element.hidden || (this.width === width && this.height === height)) { return; }
		this.width = width;
		this.height = height;
		this.split.layout(width, height);
	}

	private addSidebar(side: SidebarSide, pane: AuxiliaryBarPart, layoutPane: () => void = () => { }): void {
		const { key, defaultWidth, minimumWidth, maximumWidth } = sidebars[side];
		const width = Number(this.storage.get(key, StorageScope.PROFILE));
		const layout = this;
		this.split.addView({
			element: pane.domNode,
			get minimumSize() { return Math.min(minimumWidth, Math.floor(layout.width / 4)); },
			maximumSize: maximumWidth,
			preserveSize: true,
			layout: (width, _offset, height) => {
				pane.layout({ width, height });
				layoutPane();
			},
			setVisible: visible => pane.setVisible(visible),
		}, { type: 'invisible', cachedVisibleSize: width > 0 && width <= maximumWidth ? width : defaultWidth });
	}
}
