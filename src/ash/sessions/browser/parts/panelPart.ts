import { getViewTitleActions, ViewTitleActionViewItem } from '../codeCardLayout.js';
import { ActionBar } from '../../../base/browser/ui/actionbar/actionbar.js';
import { localize } from '../../../nls.js';
import { IActivityService } from '../../../workbench/services/activity/common/activity.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { PanelPart as WorkbenchPanelPart } from '../../../workbench/browser/parts/panel/panelPart.js';
import { IMenuService } from '../../../platform/actions/common/actions.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IViewDescriptorService } from '../../../workbench/common/views.js';
import { ILocalizationService } from '../../../workbench/services/localization/common/localizationService.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../platform/layout/browser/layoutService.js';
import { defaultButtonStyles } from '../../../platform/theme/browser/defaultStyles.js';
import type { IAgentWorkbenchLayoutService } from '../workbench.js';

/** Retains Code's tool views without creating terminal processes when the panel is hidden. */
export class PanelPart extends WorkbenchPanelPart {
	constructor(
		container: HTMLElement,
		@IViewDescriptorService descriptors: IViewDescriptorService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IStorageService storage: IStorageService,
		@IActivityService activityService: IActivityService,
		@ILocalizationService localization: ILocalizationService,
		@IMenuService menus: IMenuService,
		@IContextMenuService contextMenus: IContextMenuService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@ILayoutService layout: IAgentWorkbenchLayoutService,
	) {
		super(container, descriptors, contextKeys, storage, localization, menus, contextMenus, instantiationService, themeService, activityService);
		const views = layout.codeCards;
		if (views) {
			const actions = this._register(new ActionBar(this.titleDomNode, {
				ariaLabel: localize('sessions.cards.terminal', 'Terminal'),
				actionViewItemProvider: (action, options) => new ViewTitleActionViewItem(action, options),
				actionViewItemOptions: { buttonStyles: defaultButtonStyles, buttonPresentation: 'quiet', iconOnly: true },
			}));
			actions.element.classList.add('ash-code-card-controls');
			const update = (): void => {
				actions.element.hidden = !views.active;
				this.domNode.classList.toggle('ash-code-card-managed', views.active);
				actions.updateActions(getViewTitleActions(views, 'terminal'));
			};
			this._register(views.onDidChangeCards(update));
			update();
		}
	}

	public get header(): HTMLElement { return this.titleDomNode; }
	public focus(): void { this.getActiveComposite()?.focus(); }
}
