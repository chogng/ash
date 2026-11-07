import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import './media/activityBarPart.css';
import { addDisposableListener, getWindow, h, isHTMLElement } from '../../../../base/browser/dom.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { AnimationFrameScheduler } from '../../../../base/browser/scheduler.js';
import { MenuActionViewItem, type MenuActionViewItemOptions } from '../../../../base/browser/ui/menu/menu.js';
import { parse } from '../../../../base/common/json.js';
import { Button, type IButtonOptions } from '../../../../base/browser/ui/button/button.js';
import { DropdownMenuActionViewItem } from '../../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { Separator, SubmenuAction, type IAction } from '../../../../base/common/actions.js';
import { AnchorAxisAlignment } from '../../../../base/common/layout.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { CompositeActionViewItem, getActivityHoverPosition } from '../../../../workbench/browser/parts/compositeBarActions.js';
import { ActivityBarPosition } from '../../../../workbench/common/configuration.js';
import { SessionsConfiguration, type SessionsActivityBarLocation } from '../../../common/configuration.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { getFittingActionCount } from '../../../../base/browser/ui/toolbar/toolbar.js';
import { ActionViewItem, ButtonActionViewItem, type ActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { autorun, observableValue, type IObservable } from '../../../../base/common/observable.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { Menus } from '../../menus.js';
import { ActivityBarItemContext } from '../../../common/contextkeys.js';

interface ActivityBarDelegate {
	showAccountMenu(anchor: HTMLElement, selectFirst: boolean): void;
}

const pinnedActionsKey = 'sessions.activityBar.pinnedCodeActions';
const actionOrderKey = 'sessions.activityBar.actionOrder';
const previousCodeOrderKey = 'sessions.activityBar.codeActionOrder';
const previousPageOrderKey = 'sessions.activityBar.pageOrder';

/** Owns navigation actions and Accounts; SidebarPart supplies their visible hosts. */
export class ActivityBar extends Disposable {
	public readonly domNode: HTMLDivElement;
	private readonly navigation: ActionBar;
	private readonly accounts: ActionBar;
	public readonly accountAction: IAction;
	private readonly showAccountMenu: (anchor: HTMLElement, selectFirst: boolean) => void;
	private readonly moreAction: IAction = {
		id: 'sessions.activity.more',
		label: localize('sessions.activity.more', 'More'),
		tooltip: '',
		icon: Lxicon.ellipsis,
		enabled: true,
		run() { },
	};
	private readonly actions = new Map<string, ActivityAction>();
	private order: string[];
	private readonly pinnedActions = observableValue<ReadonlySet<string>>(this, new Set());
	private moreActionIds = new Set<string>();
	private menuActions: readonly ActivityAction[] = [];
	private orderedActions: ActivityAction[] = [];
	private draggedActionId: string | undefined;
	private labeled = true;

	public get accountContainer(): HTMLElement { return this.accounts.domNode; }

	constructor(
		container: HTMLElement,
		delegate: ActivityBarDelegate,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IHoverService private readonly hoverService: IHoverService,
		@IMenuService private readonly menus: IMenuService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IStorageService private readonly storage: IStorageService,
	) {
		super();
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = 'ash-sessions-activity-content labeled';
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this.order = this.readOrder();
		this.pinnedActions.set(this.readPinnedActions());
		const menu = this._register(menus.createMenu(Menus.ActivityBar, contextKeys));
		this.navigation = this._register(new ActionBar(this.domNode, {
			actionViewItemOptions: { buttonStyles: defaultButtonStyles },
			ariaLabel: localize('sessions.activity.navigation', 'Navigation'),
			orientation: 'vertical',
			actionViewItemProvider: action => action === this.moreAction
				? new MoreActionViewItem(action, contextMenuService, () => this.menuActions, this.labeled ? {
					pins: this.pinnedActions,
					setPinned: (id, pinned) => this.setActionPinned(id, pinned),
				} : undefined)
				: new CompositeActionViewItem(action, {
					presentation: 'navigation',
					navigationClassName: 'ash-sessions-activity-item',
					navigationLabel: this.labeled ? 'visible' : 'hidden',
					onDidChange: (action as ActivityAction).current.onDidChange,
					hoverOptions: { position: () => getActivityHoverPosition(this.configurationService.getValue<ActivityBarPosition>(SessionsConfiguration.activityBarLocation), 'left') },
				}),
			dragAndDrop: {
				canDrop: (_event, target) => this.draggedActionId !== undefined && target !== this.moreAction,
				onDragStart: (action, event) => {
					this.draggedActionId = action.id;
					event.dataTransfer!.setData('text/plain', action.id);
					event.dataTransfer!.effectAllowed = 'move';
				},
				onDrop: (target, position) => {
					const id = this.draggedActionId!;
					this.draggedActionId = undefined;
					this.moveAction(id, target?.id, position);
				},
				onDragEnd: () => { this.draggedActionId = undefined; },
			},
		}));
		this.navigation.domNode.classList.add('ash-sessions-navigation');
		const layout = this._register(new AnimationFrameScheduler(getWindow(this.domNode), () => {
			if (!this.labeled) this.renderNavigation();
		}));
		this._register(observeResize(this.navigation.domNode, () => {
			if (!this.labeled) layout.schedule();
		}));
		const updateActions = (): void => {
			const groups = menu.getActions();
			const more = groups.find(([group]) => group === 'more')?.[1] ?? [];
			this.moreActionIds = new Set(more.map(action => action.id));
			const entries = [...groups.flatMap(([group, actions]) => group === 'more' ? [] : actions), ...more];
			for (const id of this.actions.keys()) {
				if (!entries.some(action => action.id === id)) { this.actions.delete(id); }
			}
			for (const action of entries) {
				const retained = this.actions.get(action.id);
				if (retained) { retained.current.set(action); }
				else { this.actions.set(action.id, new ActivityAction(action)); }
			}
			const registered = entries.map(action => this.actions.get(action.id)!);
			this.orderedActions = [
				...this.order.filter(id => this.actions.has(id)).map(id => this.actions.get(id)!),
				...registered.filter(action => !this.order.includes(action.id)),
			];
			this.renderNavigation();
		};
		this._register(menu.onDidChange(updateActions));
		this._register(storage.onDidChangeValue(event => {
			if (event.scope !== StorageScope.PROFILE) return;
			if (event.key === pinnedActionsKey) {
				this.pinnedActions.set(this.readPinnedActions());
				this.renderNavigation({ retainOpenDropdowns: true });
			} else if (event.external && event.key === actionOrderKey) {
				this.order = this.readOrder();
				updateActions();
			}
		}));
		updateActions();

		const accountLabel = localize('workbench.accounts', 'Accounts');
		this.accountAction = { id: 'sessions.activity.accounts', label: accountLabel, tooltip: accountLabel, icon: Lxicon.account, enabled: true, run() { } };
		this.showAccountMenu = (anchor, selectFirst) => delegate.showAccountMenu(anchor, selectFirst);
		this.accounts = this._register(new ActionBar(this.domNode, {
			actionViewItemOptions: { buttonStyles: defaultButtonStyles },
			ariaLabel: accountLabel,
			orientation: 'vertical',
			actionViewItemProvider: (action, options) => this.createAccountActionViewItem(action, options, 'sidebar'),
		}));
		this.accounts.domNode.classList.add('ash-sessions-activity-bottom', 'labeled');
		this.accounts.setActions([this.accountAction]);
		this._register(addDisposableListener(this.domNode, 'contextmenu', event => this.showContextMenu(event)));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) this.showContextMenu(event);
		}));
	}

	public setLocation(location: SessionsActivityBarLocation, host: HTMLElement, accountHost?: HTMLElement): void {
		const focused = this.domNode.ownerDocument.activeElement as HTMLElement | null;
		const focusedId = focused?.closest<HTMLElement>('[data-action-id]')?.dataset.actionId;
		const navigationTabStop = this.navigation.domNode.querySelector('[tabindex="0"]')?.closest<HTMLElement>('[data-action-id]')?.dataset.actionId;
		const accounts = this.accounts.domNode;
		const restoreFocus = focused && (this.domNode.contains(focused) || accounts.contains(focused));
		const labeled = location === ActivityBarPosition.DEFAULT;
		const presentationChanged = this.labeled !== labeled;
		this.labeled = labeled;
		host.append(this.domNode);
		if (accountHost) {
			accountHost.append(accounts);
		} else {
			accounts.remove();
		}
		this.domNode.classList.toggle('labeled', labeled);
		const horizontal = !labeled;
		this.domNode.classList.toggle('horizontal', horizontal);
		this.navigation.setOrientation(horizontal ? 'horizontal' : 'vertical');
		if (presentationChanged) {
			// The same actions retain order and selection while their button presentation changes.
			this.navigation.setActions([]);
		}
		this.renderNavigation();
		if (navigationTabStop) { this.restoreNavigationTabStop(navigationTabStop); }
		this.accounts.setActions(accountHost ? [this.accountAction] : []);
		if (restoreFocus && focusedId) {
			if (focusedId === this.accountAction.id && accountHost) {
				this.accounts.setTabStop(focusedId);
				this.accounts.focus();
			} else {
				this.restoreNavigationTabStop(focusedId);
				this.navigation.focus();
			}
		}
	}

	public createAccountActionViewItem(action: IAction, options: ActionViewItemOptions, presentation: 'sidebar' | 'titlebar'): ActionViewItem {
		return new AccountActionViewItem(action, options, presentation, this.showAccountMenu, event => this.showContextMenu(event), anchor => this.hoverService.setupDelayedHover(anchor, () => ({
			content: action.label,
			position: { hoverPosition: presentation === 'titlebar' ? HoverPosition.BELOW : getActivityHoverPosition(this.configurationService.getValue<ActivityBarPosition>(SessionsConfiguration.activityBarLocation), 'left') },
		}), { groupId: options.hoverGroupId }));
	}

	private showContextMenu(event: MouseEvent | KeyboardEvent): void {
		event.preventDefault();
		event.stopPropagation();
		this.contextMenuService.showContextMenu({
			getAnchor: () => event.type === 'contextmenu'
				? { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY, targetWindow: this.domNode.ownerDocument.defaultView ?? undefined }
				: event.target as HTMLElement,
			getActions: () => Separator.join([...this.getItemContextMenuActions(event.target as Element)], [...this.getUnpinActions(event.target as Element)], [...this.getOrderActions(event.target as Element)], [...this.getContextMenuActions()]),
			getCheckedActionsRepresentation: () => 'radio',
			autoSelectFirstItem: event.type === 'keydown',
		});
	}

	private getItemContextMenuActions(target: Element): readonly IAction[] {
		const id = target.closest<HTMLElement>('[data-action-id]')?.dataset.actionId;
		if (!id) { return []; }
		// Menu actions snapshot their conditions; a detached scope keeps the target out of window state.
		using context = this.contextKeys.createScoped(h(this.domNode.ownerDocument, 'div'));
		ActivityBarItemContext.bindTo(context).set(id);
		return Separator.join(...this.menus.getMenuActions(Menus.ActivityBarContext, { renderShortTitle: true }, context).map(([, actions]) => [...actions]));
	}

	private getContextMenuActions(): readonly IAction[] {
		const location = this.configurationService.getValue<SessionsActivityBarLocation>(SessionsConfiguration.activityBarLocation);
		const positions: IAction[] = [
			{ id: 'sessions.action.activityBar.position.default', label: localize('workbench.activityBarPositionDefault', 'Default'), tooltip: '', enabled: true, checked: location === ActivityBarPosition.DEFAULT, run: () => this.configurationService.updateValue(SessionsConfiguration.activityBarLocation, ActivityBarPosition.DEFAULT) },
			{ id: 'sessions.action.activityBar.position.top', label: localize('workbench.activityBarPositionTop', 'Top'), tooltip: '', enabled: true, checked: location === ActivityBarPosition.TOP, run: () => this.configurationService.updateValue(SessionsConfiguration.activityBarLocation, ActivityBarPosition.TOP) },
			{ id: 'sessions.action.activityBar.position.bottom', label: localize('workbench.activityBarPositionBottom', 'Bottom'), tooltip: '', enabled: true, checked: location === ActivityBarPosition.BOTTOM, run: () => this.configurationService.updateValue(SessionsConfiguration.activityBarLocation, ActivityBarPosition.BOTTOM) },
		];
		return [new SubmenuAction('sessions.action.activityBar.position', localize('workbench.activityBarPosition', 'Activity Bar Position'), positions)];
	}

	private getUnpinActions(target: Element): readonly IAction[] {
		const id = target.closest<HTMLElement>('[data-action-id]')?.dataset.actionId;
		if (!id || !this.moreActionIds.has(id) || !this.pinnedActions.get().has(id)) return [];
		return [{
			id: 'sessions.activity.unpin',
			label: localize('sessions.activity.unpin', 'Unpin from Sidebar'),
			icon: Lxicon.unpin,
			tooltip: '',
			enabled: true,
			run: () => {
				this.setActionPinned(id, false);
				this.navigation.setTabStop(this.labeled ? this.moreAction.id : id);
				this.navigation.focus();
			},
		}];
	}

	private readPinnedActions(): Set<string> {
		const saved = parse(this.storage.get(pinnedActionsKey, StorageScope.PROFILE, '[]'));
		return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []);
	}

	private setActionPinned(id: string, pinned: boolean): void {
		const action = this.actions.get(id);
		if (!action || !this.moreActionIds.has(id)) return;
		const pins = this.readPinnedActions();
		if (pinned) pins.add(id);
		else pins.delete(id);
		this.storage.store(pinnedActionsKey, JSON.stringify([...pins]), StorageScope.PROFILE, StorageTarget.USER);
		status(pinned
			? localize('sessions.activity.pinned', '{0} pinned to the sidebar.', action.label)
			: localize('sessions.activity.unpinned', '{0} unpinned from the sidebar.', action.label));
	}

	private getOrderActions(target: Element): readonly IAction[] {
		const id = target.closest<HTMLElement>('[data-action-id]')?.dataset.actionId;
		const actions = this.primaryActions;
		const index = actions.findIndex(action => action.id === id);
		if (index < 0) { return []; }
		return [
			{ id: 'sessions.activity.moveBefore', label: localize('sessions.activity.moveBefore', 'Move earlier'), tooltip: '', enabled: index > 0, run: () => this.moveAction(id!, actions[index - 1]!.id, 'before') },
			{ id: 'sessions.activity.moveAfter', label: localize('sessions.activity.moveAfter', 'Move later'), tooltip: '', enabled: index < actions.length - 1, run: () => this.moveAction(id!, actions[index + 1]!.id, 'after') },
		];
	}

	private moveAction(id: string, targetId: string | undefined, position: 'before' | 'after'): void {
		const action = this.actions.get(id);
		if (!action || id === targetId || (targetId !== undefined && !this.actions.has(targetId))) { return; }
		const actions = this.orderedActions.filter(action => action.id !== id);
		const index = targetId === undefined ? actions.length : actions.findIndex(action => action.id === targetId) + (position === 'after' ? 1 : 0);
		actions.splice(index, 0, action);
		this.orderedActions = actions;
		// Keep the slots of actions contributed only in the other workspace mode.
		const reordered = actions.map(action => action.id);
		let next = 0;
		this.order = [...this.order.map(id => this.actions.has(id) ? reordered[next++]! : id), ...reordered.slice(next)];
		this.storage.store(actionOrderKey, JSON.stringify(this.order), StorageScope.PROFILE, StorageTarget.USER);
		this.renderNavigation();
		this.restoreNavigationTabStop(id);
		this.navigation.focus();
		const visible = this.primaryActions;
		status(localize('sessions.activity.moved', '{0}, position {1} of {2}', action.label, visible.findIndex(action => action.id === id) + 1, visible.length));
	}

	private get primaryActions(): readonly ActivityAction[] {
		return this.labeled
			? this.orderedActions.filter(action => !this.moreActionIds.has(action.id) || this.pinnedActions.get().has(action.id))
			: this.orderedActions;
	}

	private restoreNavigationTabStop(id: string): void {
		const action = id === this.moreAction.id ? this.moreAction : this.actions.get(id);
		if (action?.enabled && this.navigation.hasAction(action)) {
			this.navigation.setTabStop(id);
		} else if (this.navigation.hasAction(this.moreAction)) {
			this.navigation.setTabStop(this.moreAction.id);
		}
	}

	private renderNavigation(options?: { readonly retainOpenDropdowns?: boolean; }): void {
		const actions = this.primaryActions;
		let visible = actions;
		if (this.labeled) {
			this.menuActions = this.orderedActions.filter(action => this.moreActionIds.has(action.id));
		} else {
			const bar = this.navigation.domNode;
			const availableWidth = bar.getBoundingClientRect().width;
			const styles = getWindow(bar).getComputedStyle(bar);
			const actionWidth = Number.parseFloat(styles.getPropertyValue('--ash-spacing-size240'));
			// A hidden sidebar is measured when it becomes visible again.
			const count = availableWidth > 0 && actionWidth > 0 ? getFittingActionCount(actions, this.moreAction, {
				availableWidth,
				gap: Number.parseFloat(styles.columnGap) || 0,
				getWidth: () => actionWidth,
			}) : actions.length;
			visible = actions.slice(0, count);
			this.menuActions = actions.slice(count);
		}
		const activeElement = this.domNode.ownerDocument.activeElement;
		const focusedAction = isHTMLElement(activeElement) ? this.navigation.getAction(activeElement) : undefined;
		this.navigation.setActions(this.menuActions.length > 0 ? [...visible, this.moreAction] : visible, options);
		if (focusedAction && this.menuActions.some(action => action === focusedAction) && !this.navigation.hasAction(focusedAction)) {
			this.restoreNavigationTabStop(focusedAction.id);
			this.navigation.focus();
		}
	}

	private readOrder(): string[] {
		const read = (saved: string | undefined): string[] => {
			if (saved === undefined) return [];
			const order: unknown = parse(saved);
			if (!Array.isArray(order) || !order.every(id => typeof id === 'string') || new Set(order).size !== order.length) {
				throw new TypeError(localize('sessions.activity.invalidOrder', 'Saved navigation order is invalid.'));
			}
			return order;
		};
		const saved = this.storage.get(actionOrderKey, StorageScope.PROFILE);
		const oldPages = this.storage.get(previousPageOrderKey, StorageScope.PROFILE);
		const oldCode = this.storage.get(previousCodeOrderKey, StorageScope.PROFILE);
		if (saved === undefined && oldPages === undefined && oldCode === undefined) return [];
		const chatOrder = saved === undefined
			? read(oldPages).map(id => id === 'colab' ? 'sessions.open.collaboration' : `sessions.open.${id}`)
			: read(saved);
		// Keep the established Chat order and append entries that were saved only in Code.
		const migrated = [...new Set([...chatOrder, ...read(oldCode)].map(id => {
			if (id === 'sessions.open.chat') return 'sessions.newSession';
			return id === 'sessions.open.design' ? 'sessions.open.creator' : id;
		}).filter(id => id !== 'sessions.open.code' && id !== 'sessions.open.teams'))];
		const newIndex = migrated.indexOf('sessions.newSession');
		if (newIndex >= 0 && !migrated.includes('sessions.search')) migrated.splice(newIndex + 1, 0, 'sessions.search');
		const serialized = JSON.stringify(migrated);
		if (serialized !== saved) this.storage.store(actionOrderKey, serialized, StorageScope.PROFILE, StorageTarget.USER);
		if (oldPages !== undefined) this.storage.remove(previousPageOrderKey, StorageScope.PROFILE);
		if (oldCode !== undefined) this.storage.remove(previousCodeOrderKey, StorageScope.PROFILE);
		return migrated;
	}

	public updateHelpHint(hint: string | undefined): void {
		const label = localize('sessions.activity.navigation', 'Navigation');
		this.navigation.domNode.setAttribute('aria-label', hint ? localize('sessions.activity.helpHint', '{0}. {1}', label, hint) : label);
	}
}

class MoreActionViewItem extends DropdownMenuActionViewItem {
	constructor(action: IAction, contextMenus: IContextMenuService, getActions: () => readonly IAction[], private readonly pinControls?: {
		readonly pins: IObservable<ReadonlySet<string>>;
		readonly setPinned: (id: string, pinned: boolean) => void;
	}) {
		super(action, getActions, {
			showContextMenu: delegate => contextMenus.showContextMenu({
				...delegate,
				getActionViewItem: pinControls ? (item, options) => new PinnableMenuActionViewItem(item, options,
					pinControls.pins.map(ids => ids.has(item.id)), pinned => pinControls.setPinned(item.id, pinned)) : undefined,
				getMenuClassName: pinControls ? () => 'ash-sessions-navigation-menu' : undefined,
				getCheckedActionsRepresentation: () => 'radio',
			}),
		}, { buttonStyles: defaultButtonStyles }, () => ({ anchorAxisAlignment: AnchorAxisAlignment.Horizontal }));
	}

	protected override createButton(container: HTMLElement, options: IButtonOptions): Button {
		const button = super.createButton(container, { ...options, iconOnly: !this.pinControls });
		button.domNode.classList.add('ash-sessions-activity-item', 'ash-sessions-activity-more');
		return button;
	}
}

class PinnableMenuActionViewItem extends MenuActionViewItem {
	private readonly pinItem: ButtonActionViewItem;

	constructor(action: IAction, options: MenuActionViewItemOptions, pinned: IObservable<boolean>, setPinned: (pinned: boolean) => void) {
		super(action, options);
		this.pinItem = this._register(new SidebarPinActionViewItem(action, options, pinned, setPinned, () => this.focus()));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('ash-sessions-navigation-menu-row');
		this.pinItem.render(container);
		this._register(addDisposableListener(this.button.domNode, 'keydown', event => {
			if (event.key !== 'ArrowRight') return;
			event.preventDefault();
			this.pinItem.focus();
		}));
	}
}

class SidebarPinActionViewItem extends ButtonActionViewItem {
	constructor(
		private readonly entry: IAction,
		options: ActionViewItemOptions,
		private readonly pinned: IObservable<boolean>,
		setPinned: (pinned: boolean) => void,
		private readonly focusPrimary: () => void,
	) {
		super({
			id: 'sessions.activity.pin', label: '', tooltip: '', enabled: true, run: () => setPinned(!pinned.get()),
		}, { ...options, iconOnly: true, actionRunner: undefined });
	}

	override render(container: HTMLElement): void {
		super.render(container);
		const button = this.button.domNode;
		button.classList.add('ash-sessions-navigation-menu-pin');
		button.setAttribute('role', 'menuitem');
		this._register(autorun(reader => {
			const pinned = this.pinned.read(reader);
			const label = pinned
				? localize('sessions.activity.unpinItem', 'Unpin {0} from Sidebar', this.entry.label)
				: localize('sessions.activity.pin', 'Pin {0} to Sidebar', this.entry.label);
			this.button.icon = pinned ? Lxicon.pinFilled : Lxicon.pin;
			this.button.setTitle(label);
			button.setAttribute('aria-label', label);
		}));
		this.setTabbable(false);
		this._register(addDisposableListener(button, 'keydown', event => {
			if (event.key === 'ArrowLeft') {
				event.preventDefault();
				this.focusPrimary();
			} else if (event.key === 'Enter' || event.key === ' ') {
				// Leave activation to the native button instead of the menu's primary action.
				event.stopPropagation();
			}
		}));
	}
}

class AccountActionViewItem extends ActionViewItem {
	private button!: Button;

	constructor(
		action: IAction,
		options: ActionViewItemOptions,
		private readonly presentation: 'sidebar' | 'titlebar',
		private readonly showMenu: (anchor: HTMLElement, selectFirst: boolean) => void,
		private readonly showContextMenu: (event: MouseEvent | KeyboardEvent) => void,
		private readonly createHover: (anchor: HTMLElement) => IDisposable,
	) { super(action, options); }

	public override render(container: HTMLElement): void {
		this.button = this._register(new Button(container, {
			...defaultButtonStyles,
			label: this.action.label,
			icon: this.action.icon,
			iconOnly: this.presentation !== 'sidebar',
			onClick: event => this.showMenu(this.button.domNode, event.detail === 0),
		}));
		if (this.presentation !== 'titlebar') { this.button.domNode.classList.add('ash-sessions-activity-item'); }
		this.button.domNode.setAttribute('aria-haspopup', 'menu');
		this.button.domNode.setAttribute('aria-expanded', 'false');
		this._register(this.createHover(this.button.domNode));
		this._register(addDisposableListener(this.button.domNode, 'contextmenu', event => this.showContextMenu(event)));
		this._register(addDisposableListener(this.button.domNode, 'keydown', event => {
			if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) { this.showContextMenu(event); }
		}));
	}

	public override focus(): void { this.button.focus(); }
	public override setTabbable(tabbable: boolean): void { this.button.domNode.tabIndex = tabbable ? 0 : -1; }
}

/** Retain the button identity while menus resolve changing context keys. */
class ActivityAction implements IAction {
	public readonly current;
	public readonly id: string;
	constructor(action: IAction) {
		this.id = action.id;
		this.current = observableValue<IAction>(this, action);
	}
	public get label(): string { return this.current.get().label; }
	public get tooltip(): string { return this.current.get().tooltip; }
	public get icon(): IAction['icon'] { return this.current.get().icon; }
	public get enabled(): boolean { return this.current.get().enabled; }
	public get checked(): boolean | undefined { return this.current.get().checked; }
	public run(...args: readonly unknown[]): unknown { return this.current.get().run(...args); }
}
