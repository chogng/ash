import { onUnexpectedError } from '../../../../base/common/errors.js';
import './media/activityBarPart.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Button, type ButtonOptions } from '../../../../base/browser/ui/button/button.js';
import { Separator, SubmenuAction, type IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { getActivityHoverPosition } from '../../../../workbench/browser/parts/compositeBarActions.js';
import { ActivityBarPosition } from '../../../../workbench/common/configuration.js';
import { WorkbenchPart } from '../../../../workbench/browser/part.js';
import { SessionsConfiguration } from '../../../common/configuration.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { ActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { autorun, observableValue } from '../../../../base/common/observable.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { Menus } from '../../menus.js';

export interface ActivityBarPartDelegate {
	showAccountMenu(anchor: HTMLElement): void;
}

/** Primary view selector and account entry for the Sessions window. */
export class ActivityBarPart extends WorkbenchPart {
	private readonly navigation: ActionBar;
	private readonly actions = new Map<string, ActivityAction>();
	private order: string[];
	private orderedActions: ActivityAction[] = [];
	private draggedActionId: string | undefined;

	private compact = false;

	public override get minimumWidth(): number { return this.compact ? 36 : 44; }
	public override get maximumWidth(): number { return this.minimumWidth; }
	public get focusContainer(): HTMLElement { return this.contentDomNode; }

	constructor(
		container: HTMLElement,
		delegate: ActivityBarPartDelegate,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IHoverService private readonly hoverService: IHoverService,
		@IMenuService menus: IMenuService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IStorageService private readonly storage: IStorageService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super(container, 'activitybar');
		this.domNode.classList.replace('ash-workbench-activitybar', 'ash-sessions-activitybar');
		this.contentDomNode.classList.add('ash-sessions-activity-content');
		this.order = this.readOrder();
		const menu = this._register(menus.createMenu(Menus.ActivityBar, contextKeys));
		const top = h(container.ownerDocument, 'div');
		top.className = 'ash-sessions-activity-top';
		const bottom = h(container.ownerDocument, 'div');
		bottom.className = 'ash-sessions-activity-bottom';

		this.navigation = this._register(new ActionBar(top, {
			ariaLabel: localize('sessions.activity.navigation', 'Navigation'),
			orientation: 'vertical',
			actionViewItemProvider: action => instantiation.createInstance(ActivityActionViewItem, action as ActivityAction),
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
				onDragEnd: () => { this.draggedActionId = undefined; },
			},
		}));
		this.navigation.element.classList.add('ash-sessions-navigation');
		const updateActions = (): void => {
			const entries = menu.getActions().flatMap(([, actions]) => actions);
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
			this.navigation.setActions(this.orderedActions);
		};
		this._register(menu.onDidChange(updateActions));
		this._register(storage.onDidChangeValue(event => {
			if (event.external && event.scope === StorageScope.PROFILE && event.key === 'sessions.activityBar.actionOrder') {
				this.order = this.readOrder();
				updateActions();
			}
		}));
		updateActions();

		const accountLabel = localize('workbench.accounts', 'Accounts');
		const accountButton = this.createActivityButton(bottom, {
			label: accountLabel,
			icon: Lxicon.account,
			iconOnly: true,
			ariaLabel: accountLabel,
			title: accountLabel,
			onClick: () => delegate.showAccountMenu(accountButton.domNode),
		});
		accountButton.domNode.classList.add('ash-sessions-activity-item');
		accountButton.domNode.setAttribute('aria-haspopup', 'menu');
		accountButton.domNode.setAttribute('aria-expanded', 'false');
		this.contentDomNode.append(top, bottom);
		this._register(addDisposableListener(this.contentDomNode, 'contextmenu', event => this.showContextMenu(event)));
		this._register(addDisposableListener(this.contentDomNode, 'keydown', event => {
			if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) this.showContextMenu(event);
		}));
	}

	public setCompact(compact: boolean): void {
		if (this.compact === compact) return;
		this.compact = compact;
		this.contentDomNode.classList.toggle('compact', compact);
		this.notifyConstraintsChanged();
	}

	public setLocation(location: ActivityBarPosition, host: HTMLElement | undefined): void {
		if (location === ActivityBarPosition.TOP || location === ActivityBarPosition.BOTTOM) {
			if (!host) throw new Error(`Sessions Activity Bar host is missing for ${location}`);
			host.append(this.contentDomNode);
		} else {
			this.domNode.append(this.contentDomNode);
		}
		const horizontal = location === ActivityBarPosition.TOP || location === ActivityBarPosition.BOTTOM;
		this.contentDomNode.classList.toggle('horizontal', horizontal);
		this.navigation.setOrientation(horizontal ? 'horizontal' : 'vertical');
	}

	private showContextMenu(event: MouseEvent | KeyboardEvent): void {
		event.preventDefault();
		event.stopPropagation();
		this.contextMenuService.showContextMenu({
			getAnchor: () => event.type === 'contextmenu'
				? { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY, targetWindow: this.domNode.ownerDocument.defaultView ?? undefined }
				: event.target as HTMLElement,
			getActions: () => Separator.join([...this.getOrderActions(event.target as Element)], [...this.getContextMenuActions()]),
			getCheckedActionsRepresentation: () => 'radio',
		});
	}

	private getContextMenuActions(): readonly IAction[] {
		const location = this.configurationService.getValue<ActivityBarPosition>(SessionsConfiguration.activityBarLocation);
		const compact = this.configurationService.getValue<boolean>(SessionsConfiguration.activityBarCompact);
		const positions: IAction[] = [
			{ id: 'sessions.action.activityBar.position.default', label: localize('workbench.activityBarPositionDefault', 'Default'), tooltip: '', enabled: true, checked: location === ActivityBarPosition.DEFAULT, run: () => this.configurationService.updateValue(SessionsConfiguration.activityBarLocation, ActivityBarPosition.DEFAULT) },
			{ id: 'sessions.action.activityBar.position.top', label: localize('workbench.activityBarPositionTop', 'Top'), tooltip: '', enabled: true, checked: location === ActivityBarPosition.TOP, run: () => this.configurationService.updateValue(SessionsConfiguration.activityBarLocation, ActivityBarPosition.TOP) },
			{ id: 'sessions.action.activityBar.position.bottom', label: localize('workbench.activityBarPositionBottom', 'Bottom'), tooltip: '', enabled: true, checked: location === ActivityBarPosition.BOTTOM, run: () => this.configurationService.updateValue(SessionsConfiguration.activityBarLocation, ActivityBarPosition.BOTTOM) },
			{ id: 'sessions.action.activityBar.position.hidden', label: localize('workbench.activityBarPositionHidden', 'Hidden'), tooltip: '', enabled: true, checked: location === ActivityBarPosition.HIDDEN, run: () => this.configurationService.updateValue(SessionsConfiguration.activityBarLocation, ActivityBarPosition.HIDDEN) },
		];
		const actions: IAction[] = [new SubmenuAction('sessions.action.activityBar.position', localize('workbench.activityBarPosition', 'Activity Bar Position'), positions)];
		if (location === ActivityBarPosition.DEFAULT) {
			actions.push(new SubmenuAction('sessions.action.activityBar.size', localize('workbench.activityBarSize', 'Activity Bar Size'), [
				{ id: 'sessions.action.activityBar.size.default', label: localize('workbench.activityBarSizeDefault', 'Default'), tooltip: '', enabled: true, checked: !compact, run: () => this.configurationService.updateValue(SessionsConfiguration.activityBarCompact, false) },
				{ id: 'sessions.action.activityBar.size.compact', label: localize('workbench.activityBarSizeCompact', 'Compact'), tooltip: '', enabled: true, checked: compact, run: () => this.configurationService.updateValue(SessionsConfiguration.activityBarCompact, true) },
			]));
		}
		return actions;
	}

	private createActivityButton(container: HTMLElement, options: ButtonOptions & { title: string }): Button {
		const button = this._register(new Button(container, { ...options, title: undefined }));
		this._register(this.hoverService.setupDelayedHover(button.domNode, () => ({
			content: options.title,
			position: {
				// Sessions keeps its own placement setting and always hosts the side rail on the left.
				hoverPosition: getActivityHoverPosition(this.configurationService.getValue<ActivityBarPosition>(SessionsConfiguration.activityBarLocation), 'left'),
			},
		}), { groupId: 'actions' }));
		return button;
	}

	private getOrderActions(target: Element): readonly IAction[] {
		const id = target.closest<HTMLElement>('[data-action-id]')?.dataset.actionId;
		const actions = this.orderedActions;
		const index = actions.findIndex(action => action.id === id);
		if (index < 0) { return []; }
		return [
			{ id: 'sessions.activity.moveBefore', label: localize('sessions.activity.moveBefore', 'Move earlier'), tooltip: '', enabled: index > 0, run: () => this.moveAction(id!, actions[index - 1]!.id, 'before') },
			{ id: 'sessions.activity.moveAfter', label: localize('sessions.activity.moveAfter', 'Move later'), tooltip: '', enabled: index < actions.length - 1, run: () => this.moveAction(id!, actions[index + 1]!.id, 'after') },
		];
	}

	private moveAction(id: string, targetId: string | undefined, position: 'before' | 'after'): void {
		if (id === targetId) { return; }
		const actions = this.orderedActions.filter(action => action.id !== id);
		const index = targetId === undefined ? actions.length : actions.findIndex(action => action.id === targetId) + (position === 'after' ? 1 : 0);
		actions.splice(index, 0, this.actions.get(id)!);
		this.orderedActions = actions;
		this.order = actions.map(action => action.id);
		this.storage.store('sessions.activityBar.actionOrder', JSON.stringify(this.order), StorageScope.PROFILE, StorageTarget.USER);
		this.navigation.setActions(actions);
		this.navigation.setTabStop(id);
		this.navigation.focus();
		status(localize('sessions.activity.moved', '{0}, position {1} of {2}', this.actions.get(id)!.label, actions.findIndex(action => action.id === id) + 1, actions.length));
	}

	private readOrder(): string[] {
		const saved = this.storage.get('sessions.activityBar.actionOrder', StorageScope.PROFILE);
		const legacy = saved === undefined ? this.storage.get('sessions.activityBar.pageOrder', StorageScope.PROFILE) : undefined;
		if (saved === undefined && legacy === undefined) { return []; }
		const order: unknown = JSON.parse((saved ?? legacy)!);
		if (!Array.isArray(order) || !order.every(id => typeof id === 'string') || new Set(order).size !== order.length) {
			throw new TypeError(localize('sessions.activity.invalidOrder', 'Saved navigation order is invalid.'));
		}
		if (legacy !== undefined) {
			const migrated = order.map(id => `sessions.open.${id === 'colab' ? 'teams' : id}`);
			this.storage.store('sessions.activityBar.actionOrder', JSON.stringify(migrated), StorageScope.PROFILE, StorageTarget.USER);
			this.storage.remove('sessions.activityBar.pageOrder', StorageScope.PROFILE);
			return migrated;
		}
		return order;
	}

	public updateHelpHint(hint: string | undefined): void {
		const label = localize('sessions.activity.navigation', 'Navigation');
		this.navigation.element.setAttribute('aria-label', hint ? localize('sessions.activity.helpHint', '{0}. {1}', label, hint) : label);
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
	public get label(): string { return this.current.get().label; }
	public get tooltip(): string { return this.current.get().tooltip; }
	public get icon(): IAction['icon'] { return this.current.get().icon; }
	public get enabled(): boolean { return this.current.get().enabled; }
	public get checked(): boolean | undefined { return this.current.get().checked; }
	public run(...args: readonly unknown[]): unknown { return this.current.get().run(...args); }
}

class ActivityActionViewItem extends ActionViewItem {
	private button!: Button;

	constructor(
		private readonly activityAction: ActivityAction,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IHoverService private readonly hover: IHoverService,
	) {
		super(activityAction, { draggable: true });
	}

	public override render(container: HTMLElement): void {
		this.button = this._register(new Button(container, {
			label: this.action.label, icon: this.action.icon, iconOnly: true, onClick: () => { void Promise.resolve(this.action.run()).catch(onUnexpectedError); },
		}));
		this.button.domNode.classList.add('ash-sessions-activity-item');
		this._register(this.hover.setupDelayedHover(this.button.domNode, () => ({
			content: this.action.label,
			position: { hoverPosition: getActivityHoverPosition(this.configuration.getValue<ActivityBarPosition>(SessionsConfiguration.activityBarLocation), 'left') },
		}), { groupId: 'actions' }));
		this._register(autorun(reader => {
			const action = this.activityAction.current.read(reader);
			this.button.label = action.label;
			this.button.icon = action.icon;
			this.button.enabled = action.enabled;
			const selected = action.checked === true;
			this.button.toggleClassName('selected', selected);
			if (selected) { this.button.domNode.setAttribute('aria-current', 'page'); }
			else { this.button.domNode.removeAttribute('aria-current'); }
		}));
	}

	public override focus(): void { this.button.focus(); }
	public override setTabbable(tabbable: boolean): void { this.button.domNode.tabIndex = tabbable ? 0 : -1; }
}
