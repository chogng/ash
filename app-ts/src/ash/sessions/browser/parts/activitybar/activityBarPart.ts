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
import { autorun } from '../../../../base/common/observable.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ISessionsPageService, type ISessionsPageDescriptor } from '../../../common/pages.js';

export interface ActivityBarPartDelegate {
	focusList(): void;
	showAccountMenu(anchor: HTMLElement): void;
}

/** Primary view selector and account entry for the Sessions window. */
export class ActivityBarPart extends WorkbenchPart {
	private readonly navigation: ActionBar;
	private readonly pageActions = new Map<string, IAction>();
	private draggedPageId: string | undefined;

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
		@ISessionsPageService private readonly pages: ISessionsPageService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super(container, 'activitybar');
		this.domNode.classList.replace('ash-workbench-activitybar', 'ash-sessions-activitybar');
		this.contentDomNode.classList.add('ash-sessions-activity-content');
		const top = h(container.ownerDocument, 'div');
		top.className = 'ash-sessions-activity-top';
		const bottom = h(container.ownerDocument, 'div');
		bottom.className = 'ash-sessions-activity-bottom';

		this.navigation = this._register(new ActionBar(top, {
			ariaLabel: localize('sessions.activity.navigation', 'Pages'),
			orientation: 'vertical',
			actionViewItemProvider: action => instantiation.createInstance(PageActivityActionViewItem, action, pages.getPage(action.id)),
			dragAndDrop: {
				canDrop: () => this.draggedPageId !== undefined,
				onDragStart: (action, event) => {
					this.draggedPageId = action.id;
					event.dataTransfer!.setData('text/plain', action.id);
					event.dataTransfer!.effectAllowed = 'move';
				},
				onDrop: (target, position) => {
					const id = this.draggedPageId!;
					this.draggedPageId = undefined;
					this.pages.movePage(id, target?.id, position);
				},
				onDragEnd: () => { this.draggedPageId = undefined; },
			},
		}));
		this.navigation.element.classList.add('ash-sessions-page-navigation');
		this._register(autorun(reader => {
			const registered = pages.pages.read(reader);
			for (const id of this.pageActions.keys()) {
				if (!registered.some(page => page.id === id)) {
					this.pageActions.delete(id);
				}
			}
			for (const page of registered) {
				if (!this.pageActions.has(page.id)) {
					this.pageActions.set(page.id, {
						id: page.id, label: localize(page.titleKey, page.title), tooltip: localize(page.titleKey, page.title), icon: page.icon, enabled: true,
						run: () => {
							pages.openPage(page.id);
							if (page.layout.conversation === 'chat') { delegate.focusList(); }
						},
					});
				}
			}
			this.navigation.setActions(registered.map(page => this.pageActions.get(page.id)!));
		}));

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
			getActions: () => Separator.join([...this.getPageOrderActions(event.target as Element)], [...this.getContextMenuActions()]),
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

	private getPageOrderActions(target: Element): readonly IAction[] {
		const id = target.closest<HTMLElement>('[data-action-id]')?.dataset.actionId;
		const pages = this.pages.pages.get();
		const index = pages.findIndex(page => page.id === id);
		if (index < 0) { return []; }
		return [
			{ id: 'sessions.activity.moveBefore', label: localize('sessions.activity.moveBefore', 'Move earlier'), tooltip: '', enabled: index > 0, run: () => this.movePage(id!, pages[index - 1]!.id, 'before') },
			{ id: 'sessions.activity.moveAfter', label: localize('sessions.activity.moveAfter', 'Move later'), tooltip: '', enabled: index < pages.length - 1, run: () => this.movePage(id!, pages[index + 1]!.id, 'after') },
		];
	}

	private movePage(id: string, targetId: string, position: 'before' | 'after'): void {
		this.pages.movePage(id, targetId, position);
		this.navigation.setTabStop(id);
		this.navigation.focus();
		status(localize('sessions.activity.moved', '{0}, position {1} of {2}', localize(this.pages.getPage(id).titleKey, this.pages.getPage(id).title), this.pages.pages.get().findIndex(page => page.id === id) + 1, this.pages.pages.get().length));
	}

	public updateHelpHint(hint: string | undefined): void {
		const label = localize('sessions.activity.navigation', 'Pages');
		this.navigation.element.setAttribute('aria-label', hint ? localize('sessions.activity.helpHint', '{0}. {1}', label, hint) : label);
	}
}

class PageActivityActionViewItem extends ActionViewItem {
	private button!: Button;

	constructor(
		action: IAction,
		private readonly page: ISessionsPageDescriptor,
		@ISessionsPageService private readonly pages: ISessionsPageService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IHoverService private readonly hover: IHoverService,
	) {
		super(action, { draggable: true });
	}

	public override render(container: HTMLElement): void {
		this.button = this._register(new Button(container, {
			label: localize(this.page.titleKey, this.page.title), icon: this.page.icon, iconOnly: true, ariaLabel: localize(this.page.titleKey, this.page.title), onClick: () => this.action.run(),
		}));
		this.button.domNode.classList.add('ash-sessions-activity-item');
		this._register(this.hover.setupDelayedHover(this.button.domNode, () => ({
			content: localize(this.page.titleKey, this.page.title),
			position: { hoverPosition: getActivityHoverPosition(this.configuration.getValue<ActivityBarPosition>(SessionsConfiguration.activityBarLocation), 'left') },
		}), { groupId: 'actions' }));
		this._register(autorun(reader => {
			const selected = this.pages.activePage.read(reader) === this.page.id;
			this.button.icon = selected ? this.page.activeIcon ?? this.page.icon : this.page.icon;
			this.button.toggleClassName('selected', selected);
			if (selected) { this.button.domNode.setAttribute('aria-current', 'page'); }
			else { this.button.domNode.removeAttribute('aria-current'); }
		}));
	}

	public override focus(): void { this.button.focus(); }
	public override setTabbable(tabbable: boolean): void { this.button.domNode.tabIndex = tabbable ? 0 : -1; }
}
