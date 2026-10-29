import '../activitybar/media/activityaction.css';
import { IActivityService } from '../../../services/activity/common/activity.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IActivityHoverOptions } from '../compositeBarActions.js';
import './media/sidebarpart.css';
import { Dimension, h } from '../../../../base/browser/dom.js';
import { MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IBoundarySashes } from '../../../../base/browser/ui/sash/sash.js';
import { IWorkbenchLayoutService, Position } from '../../../services/layout/browser/layoutService.js';
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { ViewContainerLocation, type IViewContainerDescriptor } from '../../../common/views.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import type { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import type { ILocalizationService, LocalizationKey } from '../../../services/localization/common/localizationService.js';
import { localize2 } from '../../../../nls.js';
import type { IViewDescriptorService } from '../../../common/views.js';
import { PaneCompositePart, type PaneCompositeTitleActions } from '../paneCompositePart.js';
import { ActivityBarPosition, WorkbenchConfiguration } from '../../../common/configuration.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { VisibleViewContainersTracker } from '../visibleViewContainersTracker.js';
import type { ICompositeBarOptions } from '../compositeBar.js';
import type { PartTitleProjection } from '../views/viewPane.js';

/** Construction inputs for a Sidebar Composite host. */
export interface SidebarPartOptions {
	readonly openComposite: ICompositeBarOptions['openComposite'];
	readonly activityHoverOptions?: IActivityHoverOptions;
	readonly viewDescriptorService: IViewDescriptorService;
	readonly contextKeyService?: IContextKeyService;
	readonly localizationService?: ILocalizationService;
	readonly id?: string;
	readonly location?: ViewContainerLocation;
	readonly ariaLabel?: string;
	readonly ariaLabelKey?: LocalizationKey;
	readonly viewsAriaLabel?: string;
	readonly viewsAriaLabelKey?: LocalizationKey;
	/** Selects which registered containers receive items in the hosted CompositeBar. */
	readonly compositeBarContainerFilter?: (container: IViewContainerDescriptor) => boolean;
	readonly compositeBarVisible?: boolean;
	readonly compositeBarContextMenuProvider?: IContextMenuProvider;
	readonly titleActions?: PaneCompositeTitleActions;
}

/** Reusable Pane Composite Part presented at the side of the Workbench. */
export class SidebarPart extends PaneCompositePart {
	private readonly activeTitleDomNode: HTMLSpanElement | undefined;
	private readonly topCompositeBarDomNode: HTMLDivElement | undefined;
	private readonly bottomCompositeBarDomNode: HTMLDivElement | undefined;
	private readonly activeTitleListener = this._register(new MutableDisposable());
	private readonly boundarySashPresentation = this._register(new MutableDisposable());
	private readonly visibleViewContainersTracker: VisibleViewContainersTracker | undefined;
	private activityBarLocation = ActivityBarPosition.DEFAULT;
	override get minimumWidth(): number { return 170; }
	override get maximumWidth(): number { return Number.POSITIVE_INFINITY; }
	override get preferredWidth(): number | undefined {
		const active = this.activeCompositeId;
		const width = active ? this.getComposite(active)?.getOptimalWidth() : undefined;
		return width === undefined ? undefined : Math.max(width, 300);
	}

	constructor(
		container: HTMLElement,
		options: SidebarPartOptions,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IActivityService activityService: IActivityService,
		@IWorkbenchLayoutService private readonly layoutService: Pick<IWorkbenchLayoutService, 'getSideBarPosition'>,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		const location = options.location ?? ViewContainerLocation.Sidebar;
		super(container, {
			openComposite: options.openComposite,
			activityHoverOptions: options.activityHoverOptions,
			viewDescriptorService: options.viewDescriptorService,
			contextKeyService: options.contextKeyService,
			localizationService: options.localizationService,
			id: options.id ?? 'sidebar',
			location,
			ariaLabel: options.ariaLabel ?? localize2({ bundle: 'ash.regions', key: 'primarySidebar' }, 'Primary sidebar').original,
			ariaLabelKey: options.ariaLabelKey,
			viewsAriaLabel: options.viewsAriaLabel ?? localize2({ bundle: 'ash.regions', key: 'primarySidebarViews' }, 'Primary side bar views').original,
			viewsAriaLabelKey: options.viewsAriaLabelKey,
			compositeBarContainerFilter: options.compositeBarContainerFilter,
			compositeBarVisible: options.compositeBarVisible,
			compositeBarContextMenuProvider: options.compositeBarContextMenuProvider,
			compositeBarOrientation: location === ViewContainerLocation.Sidebar ? 'vertical' : 'horizontal',
			titleActions: options.titleActions,
		}, themeService, storageService, activityService);
		this.domNode.classList.add('ash-sidebar-part');
		if (location === ViewContainerLocation.Sidebar) {
			// In top and bottom mode the view selector belongs to the sidebar, so the sidebar keeps its full grid height.
			this.topCompositeBarDomNode = h(container.ownerDocument, 'div');
			this.topCompositeBarDomNode.className = 'ash-sidebar-composite-bar-top';
			this.topCompositeBarDomNode.hidden = true;
			this.domNode.insertBefore(this.topCompositeBarDomNode, this.titleDomNode);
			this.bottomCompositeBarDomNode = h(container.ownerDocument, 'div');
			this.bottomCompositeBarDomNode.className = 'ash-sidebar-composite-bar-bottom';
			this.bottomCompositeBarDomNode.hidden = true;
			this.domNode.append(this.bottomCompositeBarDomNode);
			this.activeTitleDomNode = h(container.ownerDocument, 'span');
			this.activeTitleDomNode.className = 'ash-sidebar-title-label';
			this.titleContentDomNode.replaceChildren(this.activeTitleDomNode);
		}
		// Sessions supplies its own navigation bar and deliberately disables this selector.
		if (location === ViewContainerLocation.Sidebar && options.compositeBarVisible !== false) {
			this.visibleViewContainersTracker = this._register(instantiationService.createInstance(VisibleViewContainersTracker, location));
			this._register(this.visibleViewContainersTracker.onDidChange(({ before, after }) => {
				if ((before > 1) !== (after > 1)) {
					this.updateActivityBarVisibility();
				}
			}));
			this._register(configurationService.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(WorkbenchConfiguration.activityBarAutoHide)) {
					this.updateActivityBarVisibility();
				}
			}));
		}
	}

	override setBoundarySashes(sashes: IBoundarySashes): void {
		this.boundarySashPresentation.clear();
		// Agent Sidebar reuses this host, but only the primary sidebar identifies this boundary.
		if (this.getId() !== 'sidebar') return;
		const sash = this.layoutService.getSideBarPosition() === Position.LEFT ? sashes.right : sashes.left;
		if (!sash) return;
		sash.element.classList.add('ash-primary-sidebar-sash');
		this.boundarySashPresentation.value = toDisposable(() => sash.element.classList.remove('ash-primary-sidebar-sash'));
	}

	public setActivityBarLocation(location: ActivityBarPosition): void {
		if (!this.topCompositeBarDomNode || !this.bottomCompositeBarDomNode) return;
		this.activityBarLocation = location;
		const isTop = location === ActivityBarPosition.TOP;
		const isBottom = location === ActivityBarPosition.BOTTOM;
		this.topCompositeBarDomNode.hidden = !isTop;
		this.bottomCompositeBarDomNode.hidden = !isBottom;
		if (isTop || isBottom) {
			this.compositeBar.setOrientation('horizontal');
			(isTop ? this.topCompositeBarDomNode : this.bottomCompositeBarDomNode).append(this.compositeBar.domNode);
		} else {
			this.compositeBar.setOrientation('vertical');
		}
		this.updateActivityBarVisibility();
	}

	private updateActivityBarVisibility(): void {
		if (!this.visibleViewContainersTracker) {
			return;
		}
		const isTop = this.activityBarLocation === ActivityBarPosition.TOP;
		const isBottom = this.activityBarLocation === ActivityBarPosition.BOTTOM;
		const hide = (isTop || isBottom)
			&& this.configurationService.getValue<boolean>(WorkbenchConfiguration.activityBarAutoHide)
			&& this.visibleViewContainersTracker.visibleCount <= 1;
		const restoreFocus = hide && this.compositeBar.domNode.contains(this.domNode.ownerDocument.activeElement);
		this.topCompositeBarDomNode!.hidden = !isTop || hide;
		this.bottomCompositeBarDomNode!.hidden = !isBottom || hide;
		this.setCompositeBarVisible(!hide);
		// Flex has changed the available content height; publish it to the retained view immediately.
		this.layout(new Dimension(this.domNode.clientWidth, this.domNode.clientHeight));
		if (restoreFocus) {
			const active = this.activeCompositeId ? this.getComposite(this.activeCompositeId) : undefined;
			if (active?.panes.length) {
				active.focus();
			} else {
				this.domNode.tabIndex = -1;
				this.domNode.focus();
			}
		}
	}

	override showComposite(compositeId: string, focus = false): void {
		super.showComposite(compositeId, focus);
		this.activeTitleListener.value = this.getComposite(compositeId)?.onTitleAreaUpdate(() => this.updateActiveTitle());
		this.updateActiveTitle();
	}

	protected override setTitleProjection(projection: PartTitleProjection | undefined): void {
		if (!this.activeTitleDomNode) {
			super.setTitleProjection(projection);
			return;
		}
		// The primary selector belongs to the Activity Bar, including while its active view moves away.
		if (!this.activeCompositeId) {
			this.activeTitleListener.clear();
			this.activeTitleDomNode.textContent = '';
		}
		super.setTitleProjection({ ...projection, content: projection?.content ?? this.activeTitleDomNode });
	}

	private updateActiveTitle(): void {
		if (!this.activeTitleDomNode || !this.activeCompositeId) return;
		const composite = this.getComposite(this.activeCompositeId);
		if (!composite) return;
		this.activeTitleDomNode.textContent = composite.getTitle();
	}
}
