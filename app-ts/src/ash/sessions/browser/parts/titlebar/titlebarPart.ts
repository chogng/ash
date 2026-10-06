import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import './media/titlebarpart.css';
import './media/menubarControl.css';
import '../../../common/theme.js';
import { h } from '../../../../base/browser/dom.js';
import type { ActionViewItemProvider } from '../../../../base/browser/ui/actionbar/actionbar.js';
import type { IAction } from '../../../../base/common/actions.js';
import { environment } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { Part } from '../../../../workbench/browser/part.js';
import { BrowserMenubarControl } from '../../../../workbench/browser/parts/titlebar/menubarControl.js';
import { WorkbenchWindowBarHeight } from '../../../../workbench/browser/parts/workbenchPartDimensions.js';
import { Menus } from '../../menus.js';

/** Window chrome and primary product actions for the dedicated Sessions Workbench. */
export class TitlebarPart extends Part {
	private readonly activityActions: WorkbenchToolBar;
	private activityActionViewItemProvider: ActionViewItemProvider | undefined;
	override get minimumHeight(): number { return WorkbenchWindowBarHeight; }
	override get maximumHeight(): number { return WorkbenchWindowBarHeight; }

	constructor(
		container: HTMLElement,
		presentation: 'application-menu' | 'actions-only',
		@IMenuService menuService: IMenuService,
		@IContextMenuService contextMenus: IContextMenuService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(container, 'titlebar', themeService, storageService);
		this.domNode.classList.add('ash-sessions-titlebar');
		const left = h(container.ownerDocument, 'div');
		left.className = 'ash-sessions-titlebar-left';
		if (environment.runtime === 'electron' && environment.os === 'mac') {
			const spacer = h(container.ownerDocument, 'div');
			spacer.className = 'ash-sessions-window-controls-spacer';
			spacer.setAttribute('aria-hidden', 'true');
			left.append(spacer);
		}
		this.contentDomNode.append(left);
		const menubar = this._register(new BrowserMenubarControl(left, menuService, contextMenus, undefined, {
			presentation,
			applicationMenuId: Menus.MenubarMainMenu,
			titlebarMenuId: Menus.TitleBarLeftLayout,
		}));
		menubar.domNode.classList.add('ash-sessions-titlebar-actions');
		const right = h(container.ownerDocument, 'div');
		right.className = 'ash-sessions-titlebar-right';
		this.contentDomNode.append(right);
		this.activityActions = this._register(new WorkbenchToolBar(right, contextMenus, {
			ariaLabel: localize('workbench.accounts', 'Accounts'),
			presentation: 'inherit-foreground',
			actionViewItemProvider: (action, options) => this.activityActionViewItemProvider?.(action, options),
		}));
	}

	public setActivityActions(actions: readonly IAction[], actionViewItemProvider: ActionViewItemProvider): void {
		this.activityActionViewItemProvider = actionViewItemProvider;
		this.activityActions.setActions([], [], actions);
	}
}
