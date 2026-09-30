import '../../../common/sessionsColors.js';
import './media/titlebarpart.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { ButtonActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { SubmenuAction, type IAction } from '../../../../base/common/actions.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { environment } from '../../../../base/common/platform.js';
import { localize, onDidChangeNls } from '../../../../nls.js';
import { MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { MenuId, type IMenu, type IMenuService } from '../../../../platform/actions/common/actions.js';
import type { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { WorkbenchPart } from '../../../../workbench/browser/part.js';
import { WorkbenchWindowBarHeight } from '../../../../workbench/browser/parts/workbenchPartDimensions.js';
import type { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';

export interface TitlebarPartDelegate {
	toggleSidebar(): void;
}

/** Window chrome and primary product actions for the dedicated Sessions Workbench. */
export class TitlebarPart extends WorkbenchPart {
	private readonly toolbar: MenuWorkbenchToolBar;
	private readonly applicationMenu: IMenu;
	private readonly applicationMenuAction: IAction;
	// The Toolbar creates the leading menu item synchronously and replaces it on refresh.
	private applicationMenuItem!: ApplicationMenuActionViewItem;
	private menuExpanded = false;
	private sidebarVisible = true;

	override get minimumHeight(): number { return WorkbenchWindowBarHeight; }
	override get maximumHeight(): number { return WorkbenchWindowBarHeight; }

	constructor(container: HTMLElement, private readonly viewService: ISessionsService, menuService: IMenuService, private readonly contextMenus: IContextMenuService, private readonly delegate: TitlebarPartDelegate) {
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
		this.applicationMenu = this._register(menuService.createMenu(MenuId.MenubarMainMenu));
		this.applicationMenuAction = {
			id: 'ash.applicationMenu',
			get label() { return localize({ bundle: 'ash.regions', key: 'applicationMenu' }, 'Application menu'); },
			get tooltip() { return this.label; },
			icon: Lxicon.menu,
			enabled: true,
			run: () => this.toggleApplicationMenu(),
		};
		this.toolbar = this._register(new MenuWorkbenchToolBar(left, menuService, contextMenus, MenuId.TitleBarLeft, {
			ariaLabel: localize({ bundle: 'ash.regions', key: 'titleBarLeftActions' }, 'Title bar left actions'),
			presentation: 'inherit-foreground',
			highlightToggledItems: true,
			leadingActions: [this.applicationMenuAction],
			actionViewItemProvider: action => {
				if (action !== this.applicationMenuAction) { return undefined; }
				const item = new ApplicationMenuActionViewItem(action, event => this.handleMenuKeyDown(event));
				this.applicationMenuItem = item;
				return item;
			},
		}));
		this.toolbar.element.classList.add('ash-sessions-titlebar-actions');
		this._register(this.toolbar.onDidChangeMenuItems(() => this.closeApplicationMenu()));
		this._register(this.applicationMenu.onDidChange(() => this.closeApplicationMenu()));
		this._register(onDidChangeNls(() => {
			this.toolbar.element.setAttribute('aria-label', localize({ bundle: 'ash.regions', key: 'titleBarLeftActions' }, 'Title bar left actions'));
			this.updateActions();
		}));
		this._register(viewService.onDidChange(() => this.updateActions()));
		this._register(toDisposable(() => this.closeApplicationMenu()));
		this.updateActions();
	}

	public updateSidebarVisibility(visible: boolean): void {
		this.sidebarVisible = visible;
		this.updateActions();
	}

	private updateActions(): void {
		this.closeApplicationMenu();
		const action = (id: string, label: string, icon: IAction['icon'], run: () => void, enabled = true, checked?: boolean): IAction => ({
			id, label, tooltip: label, icon, enabled, checked, run,
		});
		const sidebarLabel = this.sidebarVisible
			? localize('sessions.navigation.hideSidebar', 'Hide sidebar')
			: localize('sessions.navigation.showSidebar', 'Show sidebar');
		this.toolbar.setTrailingActions([
			action('ash.sessions.toggleSidebar', sidebarLabel, this.sidebarVisible ? Lxicon.layoutSidebarLeft2 : Lxicon.layoutSidebarLeftOff2, () => this.delegate.toggleSidebar(), true, this.sidebarVisible),
			action('ash.sessions.back', localize('sessions.navigation.back', 'Back'), Lxicon.arrowLeft, () => this.viewService.navigateBack(), this.viewService.canNavigateBack),
			action('ash.sessions.forward', localize('sessions.navigation.forward', 'Forward'), Lxicon.arrowRight, () => this.viewService.navigateForward(), this.viewService.canNavigateForward),
		]);
	}

	private closeApplicationMenu(): void {
		if (this.menuExpanded) { this.contextMenus.hideContextMenu(); }
	}

	private handleMenuKeyDown(event: KeyboardEvent): void {
		if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) { return; }
		if (event.key === 'ArrowDown' || event.key === 'Enter') {
			if (!this.menuExpanded) { this.toggleApplicationMenu(); }
		} else if (event.key === 'Escape' && this.menuExpanded) {
			this.closeApplicationMenu();
		} else {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
	}

	private toggleApplicationMenu(): void {
		if (this.menuExpanded) {
			this.closeApplicationMenu();
			return;
		}
		const actions = this.applicationMenu.getActions().flatMap(([, group]) => group).filter((action): action is SubmenuAction => action instanceof SubmenuAction);
		if (actions.length === 0) { return; }
		this.menuExpanded = true;
		this.applicationMenuItem.setExpanded(true);
		this.contextMenus.showContextMenu({
			getAnchor: () => this.applicationMenuItem.anchor,
			getActions: () => actions,
			// Application menu categories switch immediately while the menu is open.
			openSubmenusImmediatelyOnHover: true,
			onHide: () => {
				this.menuExpanded = false;
				this.applicationMenuItem.setExpanded(false);
			},
		});
	}
}

class ApplicationMenuActionViewItem extends ButtonActionViewItem {
	constructor(action: IAction, private readonly handleKeyDown: (event: KeyboardEvent) => void) {
		super(action);
	}

	public override render(container: HTMLElement): void {
		super.render(container);
		this.button.domNode.setAttribute('aria-haspopup', 'menu');
		this.button.domNode.setAttribute('aria-expanded', 'false');
		this._register(addDisposableListener(this.button.domNode, 'keydown', this.handleKeyDown));
	}

	public get anchor(): HTMLElement { return this.button.domNode; }

	public setExpanded(expanded: boolean): void {
		this.button.toggleClassName('active', expanded);
		this.button.domNode.setAttribute('aria-expanded', String(expanded));
	}
}
