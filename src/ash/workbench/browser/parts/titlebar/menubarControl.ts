import { defaultButtonStyles, defaultMenuStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import './media/menubarControl.css';
import { getActiveElement } from '../../../../base/browser/dom.js';
import { ActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { MenuBar, type IMenuBarOptions, type MenuBarMenu } from '../../../../base/browser/ui/menu/menubar.js';
import { HorizontalDirection, VerticalDirection } from '../../../../base/browser/ui/menu/menu.js';
import { ActionRunner, SubmenuAction, type IAction } from '../../../../base/common/actions.js';
import { Disposable, MutableDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { type IMenu, IMenuService, MenuId } from '../../../../platform/actions/common/actions.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { localize, ILocalizationService } from '../../../services/localization/common/localizationService.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';

export interface IMenubarControl extends IDisposable {
	readonly domNode: HTMLElement | undefined;
}

interface MenubarOptions {
	readonly presentation?: 'application-menu' | 'actions-only';
	readonly applicationMenuId?: MenuId;
	readonly titlebarMenuId?: MenuId;
}

/** Adapts the Base MenuBar to the containing toolbar's action and Tab lifecycle. */
class ApplicationMenuActionViewItem extends ActionViewItem {
	private readonly menubar = this._register(new MutableDisposable<MenuBar>());
	private container: HTMLElement | undefined;
	private structure: string | undefined;
	private tabbable = true;

	constructor(action: IAction, private readonly options: IMenuBarOptions, private readonly readMenus: () => MenuBarMenu[]) {
		super(action);
	}

	override render(container: HTMLElement): void {
		this.container = container;
		this.refresh();
	}

	refresh(): void {
		if (!this.container) return;
		const menus = this.readMenus();
		const structure = JSON.stringify(menus.map(menu => menu.label));
		const hadFocus = this.container.contains(getActiveElement(this.container.ownerDocument)) || this.button?.getAttribute('aria-expanded') === 'true';
		this.close();
		if (!this.menubar.value || structure !== this.structure) {
			this.menubar.clear();
			const menubar = this.menubar.value = new MenuBar(this.container, this.options, defaultMenuStyles);
			menubar.push(menus);
			this.structure = structure;
		} else {
			for (const menu of menus) this.menubar.value.updateMenu(menu);
		}
		if (this.button?.getAttribute('aria-label') !== this.action.label) this.menubar.value?.update({ ariaLabel: this.action.label });
		this.setTabbable(this.tabbable);
		if (hadFocus) this.focus();
	}

	open(): void { this.button?.click(); }
	close(): void {
		if (this.button?.getAttribute('aria-expanded') === 'true') this.button.click();
	}
	override focus(): void { this.button?.focus(); }
	override setTabbable(tabbable: boolean): void {
		this.tabbable = tabbable;
		if (this.button) this.button.tabIndex = tabbable ? 0 : -1;
	}

	private get button(): HTMLButtonElement | undefined {
		return this.container?.querySelector<HTMLButtonElement>('.ash-menubar-menu-button:not([hidden])') ?? undefined;
	}
}

/** Workbench contributions supply one menu tree; Base MenuBar owns its interaction. */
export class BrowserMenubarControl extends Disposable implements IMenubarControl {
	private readonly menu: IMenu;
	private readonly toolbar: MenuWorkbenchToolBar;
	private menuItem: ApplicationMenuActionViewItem | undefined;
	readonly domNode: HTMLElement;

	constructor(
		container: HTMLElement,
		options: MenubarOptions,
		@IMenuService menuService: IMenuService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@ILocalizationService localizationService: ILocalizationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IKeybindingService keybindingService: IKeybindingService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		const applicationMenuLabel = () => localize(localizationService, { bundle: 'ash.regions', key: 'applicationMenu' }, 'Application menu');
		this.menu = this._register(menuService.createMenu(options.applicationMenuId ?? MenuId.MenubarMainMenu, contextKeyService));
		const runner = this._register(new ActionRunner());
		this._register(runner.onDidRun(event => {
			if (!this.isDisposed && event.error !== undefined) notifications.error(toErrorMessage(event.error));
		}));
		const action: IAction = {
			id: 'ash.applicationMenu',
			get label() { return applicationMenuLabel(); },
			get tooltip() { return applicationMenuLabel(); },
			icon: Lxicon.menu, enabled: true,
			run: () => this.menuItem?.open(),
		};
		this.toolbar = this._register(new MenuWorkbenchToolBar(container, menuService, contextMenuService, options.titlebarMenuId ?? MenuId.TitleBarLeft, {
			contextKeyService,
			ariaLabel: localize(localizationService, { bundle: 'ash.regions', key: 'titleBarLeftActions' }, 'Title bar left actions'),
			presentation: 'inherit-foreground',
			highlightToggledItems: false,
			leadingActions: options.presentation === 'actions-only' ? [] : [action],
			actionViewItemProvider: candidate => {
				if (candidate !== action) return undefined;
				const item = new ApplicationMenuActionViewItem(action, {
					ariaLabel: applicationMenuLabel(), buttonStyles: defaultButtonStyles,
					enableMnemonics: true, actionRunner: runner,
					getKeybinding: candidate => keybindingService.lookupKeybinding(candidate.id),
					compactMode: { horizontal: HorizontalDirection.Right, vertical: VerticalDirection.Below },
				}, () => this.menu.getActions().flatMap(([, actions]) => actions)
					.filter((candidate): candidate is SubmenuAction => candidate instanceof SubmenuAction)
					.map(candidate => ({ label: candidate.label, actions: [...candidate.actions] })));
				this.menuItem = item;
				return item;
			},
		}));
		this.domNode = this.toolbar.element;
		this.domNode.classList.add('ash-titlebar-left-actions');
		this._register(this.toolbar.onDidChangeMenuItems(() => this.menuItem?.close()));
		this._register(this.menu.onDidChange(() => this.menuItem?.refresh()));
	}

	setTrailingActions(actions: readonly IAction[]): void {
		this.menuItem?.close();
		this.toolbar.setTrailingActions(actions);
	}
}
