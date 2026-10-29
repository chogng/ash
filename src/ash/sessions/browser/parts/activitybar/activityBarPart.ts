import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import './media/activityBarPart.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { Separator, SubmenuAction, type IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import {
	CompositeActionViewItem,
	getActivityHoverPosition,
} from '../../../../workbench/browser/parts/compositeBarActions.js';
import { ActivityBarPosition } from '../../../../workbench/common/configuration.js';
import { SessionsConfiguration } from '../../../common/configuration.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { ActionViewItem, type ActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { observableValue } from '../../../../base/common/observable.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { Menus } from '../../menus.js';
import { ActivityBarItemContext, SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';

interface ActivityBarDelegate {
	showAccountMenu(anchor: HTMLElement): void;
}

/** Owns navigation actions and Accounts; SidebarPart supplies their visible hosts. */
export class ActivityBar extends Disposable {
	public readonly domNode: HTMLDivElement;
	private readonly navigation: ActionBar;
	private readonly accounts: ActionBar;
	public readonly accountAction: IAction;
	private readonly showAccountMenu: (anchor: HTMLElement) => void;
	private readonly actions = new Map<string, ActivityAction>();
	private order: string[];
	private orderedActions: ActivityAction[] = [];
	private draggedActionId: string | undefined;
	private readonly bottomDomNode: HTMLDivElement;
	private labeled = true;

	public get accountContainer(): HTMLElement {
		return this.bottomDomNode;
	}

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
		this.order = this.readOrder();
		const menu = this._register(menus.createMenu(Menus.ActivityBar, contextKeys));
		const codeMenu = this._register(menus.createMenu(Menus.CodeActivityBar, contextKeys));
		const top = h(container.ownerDocument, 'div');
		top.className = 'ash-sessions-activity-top';
		const bottom = h(container.ownerDocument, 'div');
		bottom.className = 'ash-sessions-activity-bottom labeled';
		this.bottomDomNode = bottom;
		// Accounts can live outside the navigation root; both mounts share this lifetime.
		this._register(
			toDisposable(() => {
				this.domNode.remove();
				this.bottomDomNode.remove();
			}),
		);

		this.navigation = this._register(
			new ActionBar(top, {
				actionViewItemOptions: { buttonStyles: defaultButtonStyles },
				ariaLabel: localize('sessions.activity.navigation', 'Navigation'),
				orientation: 'vertical',
				actionViewItemProvider: action =>
					new CompositeActionViewItem(action, {
						presentation: 'navigation',
						navigationClassName: 'ash-sessions-activity-item',
						navigationLabel: this.labeled ? 'visible' : 'hidden',
						onDidChange: (action as ActivityAction).current.onDidChange,
						hoverOptions: {
							position: () =>
								getActivityHoverPosition(
									this.configurationService.getValue<ActivityBarPosition>(
										SessionsConfiguration.activityBarLocation,
									),
									'left',
								),
						},
					}),
				dragAndDrop: {
					canDrop: () => this.draggedActionId !== undefined,
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
					onDragEnd: () => {
						this.draggedActionId = undefined;
					},
				},
			}),
		);
		this.navigation.element.classList.add('ash-sessions-navigation');
		const updateActions = (): void => {
			const code = this.contextKeys.getValue(SessionsWorkspaceModeContext.key) === 'code';
			this.domNode.dataset.workspaceMode = code ? 'code' : 'chat';
			this.order = this.readOrder();
			const entries = (code ? codeMenu : menu).getActions().flatMap(([, actions]) => actions);
			for (const id of this.actions.keys()) {
				if (!entries.some(action => action.id === id)) {
					this.actions.delete(id);
				}
			}
			for (const action of entries) {
				const retained = this.actions.get(action.id);
				if (retained) {
					retained.current.set(action);
				} else {
					this.actions.set(action.id, new ActivityAction(action));
				}
			}
			const registered = entries.map(action => this.actions.get(action.id)!);
			this.orderedActions = [
				...this.order.filter(id => this.actions.has(id)).map(id => this.actions.get(id)!),
				...registered.filter(action => !this.order.includes(action.id)),
			];
			this.navigation.setActions(this.orderedActions);
		};
		this._register(menu.onDidChange(updateActions));
		this._register(codeMenu.onDidChange(updateActions));
		const workspaceModeKeys = new Set([SessionsWorkspaceModeContext.key]);
		this._register(
			contextKeys.onDidChangeContext(event => {
				if (event.affectsSome(workspaceModeKeys)) updateActions();
			}),
		);
		this._register(
			storage.onDidChangeValue(event => {
				if (event.external && event.scope === StorageScope.PROFILE && event.key === this.orderStorageKey) {
					updateActions();
				}
			}),
		);
		updateActions();

		const accountLabel = localize('workbench.accounts', 'Accounts');
		this.accountAction = {
			id: 'sessions.activity.accounts',
			label: accountLabel,
			tooltip: accountLabel,
			icon: Lxicon.account,
			enabled: true,
			run() {},
		};
		this.showAccountMenu = anchor => delegate.showAccountMenu(anchor);
		this.accounts = this._register(
			new ActionBar(bottom, {
				actionViewItemOptions: { buttonStyles: defaultButtonStyles },
				ariaLabel: accountLabel,
				orientation: 'vertical',
				actionViewItemProvider: (action, options) =>
					this.createAccountActionViewItem(action, options, 'sidebar'),
			}),
		);
		this.accounts.setActions([this.accountAction]);
		this.domNode.append(top, bottom);
		this._register(addDisposableListener(this.domNode, 'contextmenu', event => this.showContextMenu(event)));
		this._register(
			addDisposableListener(this.domNode, 'keydown', event => {
				if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) this.showContextMenu(event);
			}),
		);
	}

	public setLocation(location: ActivityBarPosition, host: HTMLElement | undefined, accountHost?: HTMLElement): void {
		const focused = this.domNode.ownerDocument.activeElement as HTMLElement | null;
		const focusedId = focused?.closest<HTMLElement>('[data-action-id]')?.dataset.actionId;
		const navigationTabStop = this.navigation.element
			.querySelector('[tabindex="0"]')
			?.closest<HTMLElement>('[data-action-id]')?.dataset.actionId;
		const restoreFocus = focused && (this.domNode.contains(focused) || this.bottomDomNode.contains(focused));
		const labeled = location === ActivityBarPosition.DEFAULT;
		const presentationChanged = this.labeled !== labeled;
		this.labeled = labeled;
		if (location === ActivityBarPosition.HIDDEN) {
			this.domNode.remove();
		} else {
			if (!host || (labeled && !accountHost))
				throw new Error(`Sessions Activity Bar host is missing for ${location}`);
			host.append(this.domNode);
		}
		(labeled ? accountHost! : this.domNode).append(this.bottomDomNode);
		this.domNode.classList.toggle('labeled', labeled);
		this.bottomDomNode.classList.toggle('labeled', labeled);
		const horizontal = location === ActivityBarPosition.TOP || location === ActivityBarPosition.BOTTOM;
		this.domNode.classList.toggle('horizontal', horizontal);
		this.navigation.setOrientation(horizontal ? 'horizontal' : 'vertical');
		if (presentationChanged) {
			// The same actions retain order and selection while their button presentation changes.
			this.navigation.setActions([]);
			this.navigation.setActions(this.orderedActions);
			if (navigationTabStop) {
				this.navigation.setTabStop(navigationTabStop);
			}
			this.accounts.setActions([]);
		}
		this.accounts.setActions(horizontal ? [] : [this.accountAction]);
		if (restoreFocus && focusedId) {
			const actions = focusedId === this.accountAction.id ? this.accounts : this.navigation;
			actions.setTabStop(focusedId);
			actions.focus();
		}
	}

	public createAccountActionViewItem(
		action: IAction,
		options: ActionViewItemOptions,
		presentation: 'sidebar' | 'titlebar',
	): ActionViewItem {
		return new AccountActionViewItem(
			action,
			options,
			presentation,
			this.showAccountMenu,
			event => this.showContextMenu(event),
			anchor =>
				this.hoverService.setupDelayedHover(
					anchor,
					() => ({
						content: action.label,
						position: {
							hoverPosition:
								presentation === 'titlebar'
									? HoverPosition.BELOW
									: getActivityHoverPosition(
											this.configurationService.getValue<ActivityBarPosition>(
												SessionsConfiguration.activityBarLocation,
											),
											'left',
										),
						},
					}),
					{ groupId: 'actions' },
				),
		);
	}

	private showContextMenu(event: MouseEvent | KeyboardEvent): void {
		event.preventDefault();
		event.stopPropagation();
		this.contextMenuService.showContextMenu({
			getAnchor: () =>
				event.type === 'contextmenu'
					? {
							x: (event as MouseEvent).clientX,
							y: (event as MouseEvent).clientY,
							targetWindow: this.domNode.ownerDocument.defaultView ?? undefined,
						}
					: (event.target as HTMLElement),
			getActions: () =>
				Separator.join(
					[...this.getItemContextMenuActions(event.target as Element)],
					[...this.getOrderActions(event.target as Element)],
					[...this.getContextMenuActions()],
				),
			getCheckedActionsRepresentation: () => 'radio',
		});
	}

	private getItemContextMenuActions(target: Element): readonly IAction[] {
		const id = target.closest<HTMLElement>('[data-action-id]')?.dataset.actionId;
		if (!id) {
			return [];
		}
		// Menu actions snapshot their conditions; a detached scope keeps the target out of window state.
		using context = this.contextKeys.createScoped(h(this.domNode.ownerDocument, 'div'));
		ActivityBarItemContext.bindTo(context).set(id);
		return Separator.join(
			...this.menus
				.getMenuActions(Menus.ActivityBarContext, { renderShortTitle: true }, context)
				.map(([, actions]) => [...actions]),
		);
	}

	private getContextMenuActions(): readonly IAction[] {
		const location = this.configurationService.getValue<ActivityBarPosition>(
			SessionsConfiguration.activityBarLocation,
		);
		const positions: IAction[] = [
			{
				id: 'sessions.action.activityBar.position.default',
				label: localize('workbench.activityBarPositionDefault', 'Default'),
				tooltip: '',
				enabled: true,
				checked: location === ActivityBarPosition.DEFAULT,
				run: () =>
					this.configurationService.updateValue(
						SessionsConfiguration.activityBarLocation,
						ActivityBarPosition.DEFAULT,
					),
			},
			{
				id: 'sessions.action.activityBar.position.top',
				label: localize('workbench.activityBarPositionTop', 'Top'),
				tooltip: '',
				enabled: true,
				checked: location === ActivityBarPosition.TOP,
				run: () =>
					this.configurationService.updateValue(
						SessionsConfiguration.activityBarLocation,
						ActivityBarPosition.TOP,
					),
			},
			{
				id: 'sessions.action.activityBar.position.bottom',
				label: localize('workbench.activityBarPositionBottom', 'Bottom'),
				tooltip: '',
				enabled: true,
				checked: location === ActivityBarPosition.BOTTOM,
				run: () =>
					this.configurationService.updateValue(
						SessionsConfiguration.activityBarLocation,
						ActivityBarPosition.BOTTOM,
					),
			},
			{
				id: 'sessions.action.activityBar.position.hidden',
				label: localize('workbench.activityBarPositionHidden', 'Hidden'),
				tooltip: '',
				enabled: true,
				checked: location === ActivityBarPosition.HIDDEN,
				run: () =>
					this.configurationService.updateValue(
						SessionsConfiguration.activityBarLocation,
						ActivityBarPosition.HIDDEN,
					),
			},
		];
		return [
			new SubmenuAction(
				'sessions.action.activityBar.position',
				localize('workbench.activityBarPosition', 'Activity Bar Position'),
				positions,
			),
		];
	}

	private getOrderActions(target: Element): readonly IAction[] {
		const id = target.closest<HTMLElement>('[data-action-id]')?.dataset.actionId;
		const actions = this.orderedActions;
		const index = actions.findIndex(action => action.id === id);
		if (index < 0) {
			return [];
		}
		return [
			{
				id: 'sessions.activity.moveBefore',
				label: localize('sessions.activity.moveBefore', 'Move earlier'),
				tooltip: '',
				enabled: index > 0,
				run: () => this.moveAction(id!, actions[index - 1]!.id, 'before'),
			},
			{
				id: 'sessions.activity.moveAfter',
				label: localize('sessions.activity.moveAfter', 'Move later'),
				tooltip: '',
				enabled: index < actions.length - 1,
				run: () => this.moveAction(id!, actions[index + 1]!.id, 'after'),
			},
		];
	}

	private moveAction(id: string, targetId: string | undefined, position: 'before' | 'after'): void {
		if (id === targetId) {
			return;
		}
		const actions = this.orderedActions.filter(action => action.id !== id);
		const index =
			targetId === undefined
				? actions.length
				: actions.findIndex(action => action.id === targetId) + (position === 'after' ? 1 : 0);
		actions.splice(index, 0, this.actions.get(id)!);
		this.orderedActions = actions;
		this.order = actions.map(action => action.id);
		this.storage.store(this.orderStorageKey, JSON.stringify(this.order), StorageScope.PROFILE, StorageTarget.USER);
		this.navigation.setActions(actions);
		this.navigation.setTabStop(id);
		this.navigation.focus();
		status(
			localize(
				'sessions.activity.moved',
				'{0}, position {1} of {2}',
				this.actions.get(id)!.label,
				actions.findIndex(action => action.id === id) + 1,
				actions.length,
			),
		);
	}

	private get orderStorageKey(): string {
		return this.contextKeys.getValue(SessionsWorkspaceModeContext.key) === 'code'
			? 'sessions.activityBar.codeActionOrder'
			: 'sessions.activityBar.actionOrder';
	}

	private readOrder(): string[] {
		const saved = this.storage.get(this.orderStorageKey, StorageScope.PROFILE);
		const legacy =
			saved === undefined && this.orderStorageKey === 'sessions.activityBar.actionOrder'
				? this.storage.get('sessions.activityBar.pageOrder', StorageScope.PROFILE)
				: undefined;
		if (saved === undefined && legacy === undefined) {
			return [];
		}
		const order: unknown = JSON.parse((saved ?? legacy)!);
		if (
			!Array.isArray(order) ||
			!order.every(id => typeof id === 'string') ||
			new Set(order).size !== order.length
		) {
			throw new TypeError(localize('sessions.activity.invalidOrder', 'Saved navigation order is invalid.'));
		}
		const includeSearch = (actions: string[]): string[] => {
			const index = actions.indexOf('sessions.newSession');
			// Introduce Search beside New once; later user reordering keeps its saved position.
			if (index >= 0 && !actions.includes('sessions.search')) {
				actions.splice(index + 1, 0, 'sessions.search');
			}
			return actions;
		};
		if (legacy !== undefined) {
			const migrated = includeSearch(
				order.map(id => {
					if (id === 'chat') {
						return 'sessions.newSession';
					}
					if (id === 'colab') {
						return 'sessions.open.teams';
					}
					if (id === 'design') {
						return 'sessions.open.creator';
					}
					return `sessions.open.${id}`;
				}),
			);
			this.storage.store(
				this.orderStorageKey,
				JSON.stringify(migrated),
				StorageScope.PROFILE,
				StorageTarget.USER,
			);
			this.storage.remove('sessions.activityBar.pageOrder', StorageScope.PROFILE);
			return migrated;
		}
		const moved = new Set([
			'sessions.open.code',
			'sessions.open.collaboration',
			'sessions.open.teams',
			'sessions.open.symphony',
			'sessionsView.manageAutomations',
		]);
		const migrated = includeSearch([
			...new Set(
				order
					.map(id => {
						if (id === 'sessions.open.chat') {
							return 'sessions.newSession';
						}
						return id === 'sessions.open.design' ? 'sessions.open.creator' : id;
					})
					.filter(id => this.orderStorageKey !== 'sessions.activityBar.actionOrder' || !moved.has(id)),
			),
		]);
		if (migrated.length !== order.length || migrated.some((id, index) => id !== order[index])) {
			this.storage.store(
				this.orderStorageKey,
				JSON.stringify(migrated),
				StorageScope.PROFILE,
				StorageTarget.USER,
			);
		}
		return migrated;
	}

	public updateHelpHint(hint: string | undefined): void {
		const label = localize('sessions.activity.navigation', 'Navigation');
		this.navigation.element.setAttribute(
			'aria-label',
			hint ? localize('sessions.activity.helpHint', '{0}. {1}', label, hint) : label,
		);
	}
}

class AccountActionViewItem extends ActionViewItem {
	private button!: Button;

	constructor(
		action: IAction,
		options: ActionViewItemOptions,
		private readonly presentation: 'sidebar' | 'titlebar',
		private readonly showMenu: (anchor: HTMLElement) => void,
		private readonly showContextMenu: (event: MouseEvent | KeyboardEvent) => void,
		private readonly createHover: (anchor: HTMLElement) => IDisposable,
	) {
		super(action, options);
	}

	public override render(container: HTMLElement): void {
		this.button = this._register(
			new Button(container, {
				...defaultButtonStyles,
				label: this.action.label,
				icon: this.action.icon,
				iconOnly: this.presentation !== 'sidebar',
				onClick: () => this.showMenu(this.button.domNode),
			}),
		);
		if (this.presentation !== 'titlebar') {
			this.button.domNode.classList.add('ash-sessions-activity-item');
		}
		this.button.domNode.setAttribute('aria-haspopup', 'menu');
		this.button.domNode.setAttribute('aria-expanded', 'false');
		this._register(this.createHover(this.button.domNode));
		this._register(addDisposableListener(this.button.domNode, 'contextmenu', event => this.showContextMenu(event)));
		this._register(
			addDisposableListener(this.button.domNode, 'keydown', event => {
				if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
					this.showContextMenu(event);
				}
			}),
		);
	}

	public override focus(): void {
		this.button.focus();
	}
	public override setTabbable(tabbable: boolean): void {
		this.button.domNode.tabIndex = tabbable ? 0 : -1;
	}
}

/** Retain the button identity while menus resolve changing context keys. */
class ActivityAction implements IAction {
	public readonly current;
	public readonly id: string;
	constructor(action: IAction) {
		this.id = action.id;
		this.current = observableValue<IAction>(this, action);
	}
	public get label(): string {
		return this.current.get().label;
	}
	public get tooltip(): string {
		return this.current.get().tooltip;
	}
	public get icon(): IAction['icon'] {
		return this.current.get().icon;
	}
	public get enabled(): boolean {
		return this.current.get().enabled;
	}
	public get checked(): boolean | undefined {
		return this.current.get().checked;
	}
	public run(...args: readonly unknown[]): unknown {
		return this.current.get().run(...args);
	}
}
