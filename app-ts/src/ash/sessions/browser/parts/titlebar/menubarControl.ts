import '../../../common/sessionsColors.js';
import './media/menubarControl.css';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { ButtonActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { SubmenuAction, type IAction } from '../../../../base/common/actions.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, onDidChangeNls } from '../../../../nls.js';
import { MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { MenuId, type IMenu, type IMenuService } from '../../../../platform/actions/common/actions.js';
import type { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';

/** Presents the menu sections registered by Sessions using shared menu and Toolbar services. */
export class MenubarControl extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly toolbar: MenuWorkbenchToolBar;
	private readonly applicationMenu: IMenu;
	// The Toolbar creates the leading menu item synchronously and replaces it on refresh.
	private applicationMenuItem!: ApplicationMenuActionViewItem;
	private menuExpanded = false;

	constructor(container: HTMLElement, menuService: IMenuService, private readonly contextMenus: IContextMenuService) {
		super();
		this.applicationMenu = this._register(menuService.createMenu(MenuId.MenubarMainMenu));
		const applicationMenuAction: IAction = {
			id: 'ash.applicationMenu',
			get label() { return localize({ bundle: 'ash.regions', key: 'applicationMenu' }, 'Application menu'); },
			get tooltip() { return this.label; },
			icon: Lxicon.menu,
			enabled: true,
			run: () => this.toggleApplicationMenu(),
		};
		this.toolbar = this._register(new MenuWorkbenchToolBar(container, menuService, contextMenus, MenuId.TitleBarLeft, {
			ariaLabel: localize({ bundle: 'ash.regions', key: 'titleBarLeftActions' }, 'Title bar left actions'),
			presentation: 'inherit-foreground',
			highlightToggledItems: true,
			leadingActions: [applicationMenuAction],
			actionViewItemProvider: action => {
				if (action !== applicationMenuAction) { return undefined; }
				const item = new ApplicationMenuActionViewItem(action, event => this.handleMenuKeyDown(event));
				this.applicationMenuItem = item;
				return item;
			},
		}));
		this.domNode = this.toolbar.element;
		this.domNode.classList.add('ash-sessions-titlebar-actions');
		this._register(this.toolbar.onDidChangeMenuItems(() => this.closeApplicationMenu()));
		this._register(this.applicationMenu.onDidChange(() => this.closeApplicationMenu()));
		this._register(onDidChangeNls(() => {
			this.closeApplicationMenu();
			this.domNode.setAttribute('aria-label', localize({ bundle: 'ash.regions', key: 'titleBarLeftActions' }, 'Title bar left actions'));
			this.toolbar.refresh();
		}));
		this._register(toDisposable(() => this.closeApplicationMenu()));
	}

	public setTrailingActions(actions: readonly IAction[]): void {
		this.closeApplicationMenu();
		this.toolbar.setTrailingActions(actions);
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
