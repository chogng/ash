import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { PanelPart as WorkbenchPanelPart } from '../../../../workbench/browser/parts/panel/panelPart.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { ILocalizationService } from '../../../../workbench/services/localization/common/localizationService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

/** Retains Code's tool views without creating terminal processes when the panel is hidden. */
export class PanelPart extends WorkbenchPanelPart {
	constructor(
		container: HTMLElement,
		@IViewDescriptorService descriptors: IViewDescriptorService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IStorageService storage: IStorageService,
		@ILocalizationService localization: ILocalizationService,
		@IMenuService menus: IMenuService,
		@IContextMenuService contextMenus: IContextMenuService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(container, descriptors, contextKeys, storage, localization, menus, contextMenus, instantiationService);
	}
}
