import "./menubarControl.css";
import { addDisposableListener } from "../../../../base/browser/dom.js";
import { ActionBar } from "../../../../base/browser/ui/actionbar/actionbar.js";
import { ButtonActionViewItem } from "../../../../base/browser/ui/actionbar/actionViewItems.js";
import { SubmenuAction, type IAction } from "../../../../base/common/actions.js";
import { Disposable, type IDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { Lxicon } from "../../../../base/common/lxicons.js";
import { type IMenu, type IMenuService, MenuId } from "../../../../platform/actions/common/actions.js";
import type { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { localize, type ILocalizationService } from "../../../services/localization/common/localizationService.js";

/** Host-selected menubar presentation owned by the titlebar. */
export interface IMenubarControl extends IDisposable {
	readonly domNode: HTMLElement | undefined;
}

class ApplicationMenuActionViewItem extends ButtonActionViewItem {
	public override render(container: HTMLElement): void {
		super.render(container);
		this.button.toggleClassName("ash-menubar-item", true);
		this.button.domNode.setAttribute("aria-haspopup", "menu");
		this.button.domNode.setAttribute("aria-expanded", "false");
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

/** Compact application-menu trigger used by web, Windows, and Linux. */
export class BrowserMenubarControl extends Disposable
	implements IMenubarControl {
	private readonly menu: IMenu;
	private readonly contextMenuService: IContextMenuService;
	private readonly menuItem: ApplicationMenuActionViewItem;
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
			label: applicationMenuLabel(),
			tooltip: applicationMenuLabel(),
			icon: Lxicon.menu,
			enabled: true,
			run: () => this.toggleMenu(),
		};
		this.menuItem = new ApplicationMenuActionViewItem(action);
		const actionBar = this._register(new ActionBar(container, {
			actions: [action],
			ariaLabel: applicationMenuLabel(),
			actionViewItemProvider: () => this.menuItem,
		}));
		this.domNode = actionBar.element;
		this.domNode.classList.add("ash-menubar");
		if (localizationService) this._register(localizationService.onDidChange(() => {
			const label = applicationMenuLabel();
			this.domNode.setAttribute("aria-label", label);
			this.menuItem.setLabel(label);
		}));
		this._register(this.menu.onDidChange(() => {
			if (this.active) this.contextMenuService.hideContextMenu();
		}));
		this._register(addDisposableListener(
			this.menuItem.anchor,
			"keydown",
			(event: KeyboardEvent) => {
				if (
					event.isComposing ||
					event.altKey ||
					event.ctrlKey ||
					event.metaKey
				) {
					return;
				}
				if (event.key === "ArrowDown" || event.key === "Enter") {
					if (!this.active) this.showMenu();
				} else if (event.key === "Escape" && this.active) {
					this.contextMenuService.hideContextMenu();
				} else {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
			},
		));
		this._register(toDisposable(() => {
			if (this.active) this.contextMenuService.hideContextMenu();
		}));
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
		this.menuItem.setExpanded(true);
		this.contextMenuService.showContextMenu({
			getAnchor: () => this.menuItem.anchor,
			getActions: () => actions,
			// These categories switch like top-level menubar entries once the application menu is open.
			openSubmenusImmediatelyOnHover: true,
			onHide: () => {
				this.active = false;
				this.menuItem.setExpanded(false);
			},
		});
	}
}
