import { Emitter } from '../../../base/common/event.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { PanelPart as WorkbenchPanelPart } from '../../../workbench/browser/parts/panel/panelPart.js';
import { PaneComposite } from '../../../workbench/browser/parts/views/paneComposite.js';
import { ViewContainerLocation } from '../../../workbench/common/views.js';
import { IMenuService, MenuId } from '../../../platform/actions/common/actions.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IViewDescriptorService } from '../../../workbench/services/views/common/viewDescriptorService.js';
import { ILocalizationService } from '../../../workbench/services/localization/common/localizationService.js';

/** Retains Code's tool views without creating terminal processes when the panel is hidden. */
export class PanelPart extends WorkbenchPanelPart {
	private readonly opened = this._register(new Emitter<string>());
	public readonly onDidPaneCompositeOpen = this.opened.event;

	constructor(
		container: HTMLElement,
		@IViewDescriptorService private readonly descriptors: IViewDescriptorService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IStorageService storage: IStorageService,
		@ILocalizationService localization: ILocalizationService,
		@IMenuService menus: IMenuService,
		@IContextMenuService contextMenus: IContextMenuService,
	) {
		super(container, { viewDescriptorService: descriptors, contextKeyService: contextKeys, storageService: storage, localizationService: localization, titleActions: { menuService: menus, contextMenuProvider: contextMenus, menuId: MenuId.PanelTitle } });
		this._register(this.onDidSelectComposite(event => this.showComposite(event.compositeId)));
	}

	public override showComposite(compositeId: string): void {
		if (!this.getComposite(compositeId)) {
			const container = this.descriptors.getViewContainers(ViewContainerLocation.Panel).find(view => view.id === compositeId);
			if (!container || container.location !== ViewContainerLocation.Panel) {
				throw new Error(`Code panel view is not registered: ${compositeId}`);
			}
			this.addComposite(new PaneComposite(this.domNode, {
				viewContainer: container,
				model: this.descriptors.getViewContainerModel(container.id),
				instantiationService: this.instantiation,
				contextKeyService: this.contextKeys,
				paneLayout: 'fill',
				paneHeaders: 'hidden',
				onDidFailCreateView: error => { throw error; },
			}));
		}
		if (this.activeCompositeId === compositeId) {
			return;
		}
		super.showComposite(compositeId);
		this.opened.fire(compositeId);
	}

}
