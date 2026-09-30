import './media/activityBarPart.css';
import { addDisposableListener, h } from '../../../base/browser/dom.js';
import { Button } from '../../../base/browser/ui/button/button.js';
import { SubmenuAction, type IAction } from '../../../base/common/actions.js';
import type { Icon } from '../../../base/common/icon.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { localize } from '../../../nls.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { ActivityBarPosition } from '../../../workbench/common/configuration.js';
import { WorkbenchPart } from '../../../workbench/browser/part.js';
import { SessionsConfiguration } from '../../common/configuration.js';

export interface ActivityBarPartDelegate {
	focusList(): void;
	selectPage(page: SessionsActivityPage): void;
	showAccountMenu(anchor: HTMLElement): void;
}

export type SessionsActivityPage = 'chat' | 'colab' | 'library' | 'code';

/** Primary view selector and account entry for the Sessions window. */
export class ActivityBarPart extends WorkbenchPart {
	private readonly chatButton: Button;
	private readonly colabButton: Button;
	private readonly libraryButton: Button;
	private readonly codeButton: Button;

	private compact = false;

	public override get minimumWidth(): number { return this.compact ? 36 : 44; }
	public override get maximumWidth(): number { return this.minimumWidth; }
	public get focusContainer(): HTMLElement { return this.contentDomNode; }

	constructor(
		container: HTMLElement,
		delegate: ActivityBarPartDelegate,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
	) {
		super(container, 'activitybar');
		this.contentDomNode.classList.add('ash-sessions-activity-content');
		const top = h(container.ownerDocument, 'div');
		top.className = 'ash-sessions-activity-top';
		const bottom = h(container.ownerDocument, 'div');
		bottom.className = 'ash-sessions-activity-bottom';

		const chatLabel = localize('sessions.activity.chat', 'Chat');
		this.chatButton = this._register(new Button(top, {
			label: chatLabel,
			icon: Lxicon.chat2Filled,
			iconOnly: true,
			ariaLabel: chatLabel,
			title: chatLabel,
			onClick: () => {
				delegate.selectPage('chat');
				delegate.focusList();
			},
		}));
		this.chatButton.domNode.classList.add('ash-sessions-activity-item', 'selected');
		this.chatButton.domNode.setAttribute('aria-current', 'page');

		const colabLabel = localize('sessions.activity.colab', 'Collaboration');
		this.colabButton = this._register(new Button(top, {
			label: colabLabel,
			icon: Lxicon.colab,
			iconOnly: true,
			ariaLabel: colabLabel,
			title: colabLabel,
			onClick: () => delegate.selectPage('colab'),
		}));
		this.colabButton.domNode.classList.add('ash-sessions-activity-item');
		const libraryLabel = localize('sessions.activity.library', 'Library');
		this.libraryButton = this._register(new Button(top, {
			label: libraryLabel,
			icon: Lxicon.library,
			iconOnly: true,
			ariaLabel: libraryLabel,
			title: libraryLabel,
			onClick: () => delegate.selectPage('library'),
		}));
		this.libraryButton.domNode.classList.add('ash-sessions-activity-item');
		const codeLabel = localize('sessions.mode.code', 'Code');
		this.codeButton = this._register(new Button(top, {
			label: codeLabel,
			icon: Lxicon.code,
			iconOnly: true,
			ariaLabel: codeLabel,
			title: codeLabel,
			onClick: () => delegate.selectPage('code'),
		}));
		this.codeButton.domNode.classList.add('ash-sessions-activity-item');
		this.addUnavailableButton(bottom, Lxicon.deviceMobile, localize('sessions.activity.mobile', 'Mobile devices'));

		const accountLabel = localize('workbench.accounts', 'Accounts');
		const accountButton = this._register(new Button(bottom, {
			label: accountLabel,
			icon: Lxicon.account,
			iconOnly: true,
			ariaLabel: accountLabel,
			title: accountLabel,
			onClick: () => delegate.showAccountMenu(accountButton.domNode),
		}));
		accountButton.domNode.classList.add('ash-sessions-activity-item');
		accountButton.domNode.setAttribute('aria-haspopup', 'menu');
		accountButton.domNode.setAttribute('aria-expanded', 'false');
		this.contentDomNode.append(top, bottom);
		this._register(addDisposableListener(this.contentDomNode, 'contextmenu', event => this.showContextMenu(event)));
		this._register(addDisposableListener(this.contentDomNode, 'keydown', event => {
			if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) this.showContextMenu(event);
		}));
	}

	public selectPage(page: SessionsActivityPage): void {
		for (const [button, selected, icon] of [
			[this.chatButton, page === 'chat', page === 'chat' ? Lxicon.chat2Filled : Lxicon.chat2],
			[this.colabButton, page === 'colab', page === 'colab' ? Lxicon.colabFilled : Lxicon.colab],
			[this.libraryButton, page === 'library', page === 'library' ? Lxicon.libraryFilled : Lxicon.library],
			[this.codeButton, page === 'code', Lxicon.code],
		] as const) {
			button.icon = icon;
			button.toggleClassName('selected', selected);
			if (selected) button.domNode.setAttribute('aria-current', 'page');
			else button.domNode.removeAttribute('aria-current');
		}
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
		this.contentDomNode.classList.toggle('horizontal', location === ActivityBarPosition.TOP || location === ActivityBarPosition.BOTTOM);
	}

	private showContextMenu(event: MouseEvent | KeyboardEvent): void {
		event.preventDefault();
		event.stopPropagation();
		this.contextMenuService.showContextMenu({
			getAnchor: () => event.type === 'contextmenu'
				? { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY, targetWindow: this.domNode.ownerDocument.defaultView ?? undefined }
				: event.target as HTMLElement,
			getActions: () => this.getContextMenuActions(),
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

	private addUnavailableButton(container: HTMLElement, icon: Icon, label: string): void {
		const unavailableLabel = localize('sessions.activity.unavailable', '{0} (coming soon)', label);
		const button = this._register(new Button(container, {
			label: unavailableLabel,
			icon,
			iconOnly: true,
			ariaLabel: unavailableLabel,
			title: unavailableLabel,
			enabled: false,
		}));
		button.domNode.classList.add('ash-sessions-activity-item');
	}

	public updateHelpHint(hint: string | undefined): void {
		const label = localize('sessions.activity.chat', 'Chat');
		this.chatButton.domNode.setAttribute('aria-label', hint
			? localize('sessions.activity.helpHint', '{0}. {1}', label, hint)
			: label);
	}
}
