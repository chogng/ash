import './media/titlebarpart.css';
import { h } from '../../../../base/browser/dom.js';
import type { IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { environment } from '../../../../base/common/platform.js';
import { localize, onDidChangeNls } from '../../../../nls.js';
import type { IMenuService } from '../../../../platform/actions/common/actions.js';
import type { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { WorkbenchPart } from '../../../../workbench/browser/part.js';
import { WorkbenchWindowBarHeight } from '../../../../workbench/browser/parts/workbenchPartDimensions.js';
import type { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { MenubarControl } from './menubarControl.js';

export interface TitlebarPartDelegate {
	toggleSidebar(): void;
}

/** Window chrome and primary product actions for the dedicated Sessions Workbench. */
export class TitlebarPart extends WorkbenchPart {
	private readonly menubar: MenubarControl;
	private sidebarVisible = true;

	override get minimumHeight(): number { return WorkbenchWindowBarHeight; }
	override get maximumHeight(): number { return WorkbenchWindowBarHeight; }

	constructor(container: HTMLElement, private readonly viewService: ISessionsService, menuService: IMenuService, contextMenus: IContextMenuService, private readonly delegate: TitlebarPartDelegate) {
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
		this.menubar = this._register(new MenubarControl(left, menuService, contextMenus));
		this._register(onDidChangeNls(() => this.updateActions()));
		this._register(viewService.onDidChange(() => this.updateActions()));
		this.updateActions();
	}

	public updateSidebarVisibility(visible: boolean): void {
		this.sidebarVisible = visible;
		this.updateActions();
	}

	private updateActions(): void {
		const action = (id: string, label: string, icon: IAction['icon'], run: () => void, enabled = true, checked?: boolean): IAction => ({
			id, label, tooltip: label, icon, enabled, checked, run,
		});
		const sidebarLabel = this.sidebarVisible
			? localize('sessions.navigation.hideSidebar', 'Hide sidebar')
			: localize('sessions.navigation.showSidebar', 'Show sidebar');
		this.menubar.setTrailingActions([
			action('ash.sessions.toggleSidebar', sidebarLabel, this.sidebarVisible ? Lxicon.layoutSidebarLeft2 : Lxicon.layoutSidebarLeftOff2, () => this.delegate.toggleSidebar(), true, this.sidebarVisible),
			action('ash.sessions.back', localize('sessions.navigation.back', 'Back'), Lxicon.arrowLeft, () => this.viewService.navigateBack(), this.viewService.canNavigateBack),
			action('ash.sessions.forward', localize('sessions.navigation.forward', 'Forward'), Lxicon.arrowRight, () => this.viewService.navigateForward(), this.viewService.canNavigateForward),
		]);
	}
}
