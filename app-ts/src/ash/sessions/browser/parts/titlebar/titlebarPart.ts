import './media/titlebarpart.css';
import './media/menubarControl.css';
import '../../../common/sessionsColors.js';
import { h } from '../../../../base/browser/dom.js';
import { environment } from '../../../../base/common/platform.js';
import type { IMenuService } from '../../../../platform/actions/common/actions.js';
import type { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { WorkbenchPart } from '../../../../workbench/browser/part.js';
import { BrowserMenubarControl } from '../../../../workbench/browser/parts/titlebar/menubarControl.js';
import { WorkbenchWindowBarHeight } from '../../../../workbench/browser/parts/workbenchPartDimensions.js';
import { Menus } from '../../menus.js';

/** Window chrome and primary product actions for the dedicated Sessions Workbench. */
export class TitlebarPart extends WorkbenchPart {
	override get minimumHeight(): number { return WorkbenchWindowBarHeight; }
	override get maximumHeight(): number { return WorkbenchWindowBarHeight; }

	constructor(container: HTMLElement, menuService: IMenuService, contextMenus: IContextMenuService) {
		super(container, 'titlebar');
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
			applicationMenuId: Menus.MenubarMainMenu,
			titlebarMenuId: Menus.TitleBarLeftLayout,
		}));
		menubar.domNode.classList.add('ash-sessions-titlebar-actions');
	}
}
