import "./menubarControl.css";
import { addDisposableListener } from "../../../../base/browser/dom.js";
import { ButtonActionViewItem } from "../../../../base/browser/ui/actionbar/actionViewItems.js";
import { SubmenuAction, type IAction } from "../../../../base/common/actions.js";
import { Disposable, type IDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { Lxicon } from "../../../../base/common/lxicons.js";
import { MenuWorkbenchToolBar } from "../../../../platform/actions/browser/toolbar.js";
import { type IMenu, type IMenuService, MenuId } from "../../../../platform/actions/common/actions.js";
import type { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { localize, type ILocalizationService } from "../../../services/localization/common/localizationService.js";

/** Host-selected menubar presentation owned by the titlebar. */
export interface IMenubarControl extends IDisposable {
	readonly domNode: HTMLElement | undefined;
}

class ApplicationMenuActionViewItem extends ButtonActionViewItem {
	constructor(action: IAction, private readonly handleKeyDown: (event: KeyboardEvent) => void) {
		super(action);
	}

	public override render(container: HTMLElement): void {
		super.render(container);
		this.button.toggleClassName("ash-menubar-item", true);
		this.button.domNode.setAttribute("aria-haspopup", "menu");
		this.button.domNode.setAttribute("aria-expanded", "false");
		this._register(addDisposableListener(this.button.domNode, "keydown", this.handleKeyDown));
	}

	public get anchor(): HTMLElement { return this.button.domNode; }

	public setLabel(label: string): void {
		this.button.label = label;
		this.button.domNode.setAttribute("aria-label", label);
		this.button.setTitle(label);
	}

	public setExpanded(expanded: boolean): void {
		this.button.toggleClassName("active", expanded);
		this.button.domNode.setAttribute("aria-expanded", String(expanded));
	}
}

/**
 * Collapses File, Edit, and other application menus into the first item of the left titlebar ActionBar.
 * Actions contributed to `MenuId.TitleBarLeft` follow it in the same keyboard and spacing group.
 * The same menu tree remains available to the macOS system menu bar.
 */
export class BrowserMenubarControl extends Disposable
	implements IMenubarControl {
	private readonly menu: IMenu;
	private readonly contextMenuService: IContextMenuService;
	private menuItem: ApplicationMenuActionViewItem | undefined;
	private active = false;

	readonly domNode: HTMLElement;

	constructor(
		container: HTMLElement,
		menuService: IMenuService,
		contextMenuService: IContextMenuService,
		localizationService?: ILocalizationService,
	) {
		super();
		this.contextMenuService = contextMenuService;
		const applicationMenuLabel = () => localize(localizationService, { bundle: "ash.regions", key: "applicationMenu" }, "Application menu");
		this.menu = this._register(menuService.createMenu(MenuId.MenubarMainMenu));
		const action: IAction = {
			id: "ash.applicationMenu",
			get label() { return applicationMenuLabel(); },
			get tooltip() { return applicationMenuLabel(); },
			icon: Lxicon.menu,
			enabled: true,
			run: () => this.toggleMenu(),
		};
		const leftActionsLabel = () => localize(localizationService, { bundle: "ash.regions", key: "titleBarLeftActions" }, "Title bar left actions");
		const toolbar = this._register(new MenuWorkbenchToolBar(container, menuService, contextMenuService, MenuId.TitleBarLeft, {
			ariaLabel: leftActionsLabel(),
			presentation: "inherit-foreground",
			leadingActions: [action],
			actionViewItemProvider: (candidate) => {
				if (candidate !== action) return undefined;
				const item = new ApplicationMenuActionViewItem(action, (event) => this.handleMenuKeyDown(event));
				this.menuItem = item;
				return item;
			},
		}));
		this.domNode = toolbar.element;
		this.domNode.classList.add("ash-menubar", "ash-titlebar-left-actions");
		this._register(toolbar.onDidChangeMenuItems(() => {
			if (this.active) this.contextMenuService.hideContextMenu();
		}));
		if (localizationService) this._register(localizationService.onDidChange(() => {
			this.domNode.setAttribute("aria-label", leftActionsLabel());
			this.currentMenuItem.setLabel(applicationMenuLabel());
		}));
		this._register(this.menu.onDidChange(() => {
			if (this.active) this.contextMenuService.hideContextMenu();
		}));
		this._register(toDisposable(() => {
			if (this.active) this.contextMenuService.hideContextMenu();
		}));
	}

	private get currentMenuItem(): ApplicationMenuActionViewItem {
		if (!this.menuItem) throw new Error("Application menu item was not rendered");
		return this.menuItem;
	}

	private handleMenuKeyDown(event: KeyboardEvent): void {
		if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
		if (event.key === "ArrowDown" || event.key === "Enter") {
			if (!this.active) this.showMenu();
		} else if (event.key === "Escape" && this.active) {
			this.contextMenuService.hideContextMenu();
		} else {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
	}

	private toggleMenu(): void {
		if (this.active) {
			this.contextMenuService.hideContextMenu();
			return;
		}
		this.showMenu();
	}

	private showMenu(): void {
		const actions = this.menu.getActions()
			.flatMap(([, groupActions]) => groupActions)
			.filter((action): action is SubmenuAction =>
				action instanceof SubmenuAction
			);
		if (actions.length === 0) return;

		this.active = true;
		this.currentMenuItem.setExpanded(true);
		this.contextMenuService.showContextMenu({
			getAnchor: () => this.currentMenuItem.anchor,
			getActions: () => actions,
			// These categories switch like top-level menubar entries once the application menu is open.
			openSubmenusImmediatelyOnHover: true,
			onHide: () => {
				this.active = false;
				this.currentMenuItem.setExpanded(false);
			},
		});
	}
}
