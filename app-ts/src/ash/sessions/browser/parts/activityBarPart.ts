import './media/activityBarPart.css';
import { h } from '../../../base/browser/dom.js';
import { Button } from '../../../base/browser/ui/button/button.js';
import type { Icon } from '../../../base/common/icon.js';
import { onUnexpectedError } from '../../../base/common/errors.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { localize } from '../../../nls.js';
import { IAccountService } from '../../../platform/accounts/common/accountService.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { WorkbenchPart } from '../../../workbench/browser/part.js';

export interface ActivityBarPartDelegate {
	focusList(): void;
}

/** Primary view selector and account entry for the Sessions window. */
export class ActivityBarPart extends WorkbenchPart {
	private readonly chatButton: Button;

	public override get minimumWidth(): number { return 56; }
	public override get maximumWidth(): number { return 56; }

	constructor(
		container: HTMLElement,
		delegate: ActivityBarPartDelegate,
		@IAccountService private readonly accountService: IAccountService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
	) {
		super(container, 'activitybar');
		const top = h(container.ownerDocument, 'div');
		top.className = 'ash-sessions-activity-top';
		const bottom = h(container.ownerDocument, 'div');
		bottom.className = 'ash-sessions-activity-bottom';

		const chatLabel = localize('sessions.activity.chat', 'Chat');
		this.chatButton = this._register(new Button(top, {
			label: chatLabel,
			icon: Lxicon.chat2,
			ariaLabel: chatLabel,
			title: chatLabel,
			onClick: () => delegate.focusList(),
		}));
		this.chatButton.domNode.classList.add('ash-sessions-activity-item', 'selected');
		this.chatButton.domNode.setAttribute('aria-current', 'page');

		this.addUnavailableButton(top, Lxicon.colab, localize('sessions.activity.colab', 'Collaboration'));
		this.addUnavailableButton(top, Lxicon.deviceMobile, localize('sessions.activity.mobile', 'Mobile devices'));

		const accountLabel = localize('workbench.accounts', 'Accounts');
		const accountButton = this._register(new Button(bottom, {
			label: accountLabel,
			icon: Lxicon.account,
			ariaLabel: accountLabel,
			title: accountLabel,
			onClick: () => void this.showAccountMenu(accountButton).catch(onUnexpectedError),
		}));
		accountButton.domNode.classList.add('ash-sessions-activity-item');
		accountButton.domNode.setAttribute('aria-haspopup', 'menu');
		accountButton.domNode.setAttribute('aria-expanded', 'false');
		this.contentDomNode.append(top, bottom);
	}

	private addUnavailableButton(container: HTMLElement, icon: Icon, label: string): void {
		const unavailableLabel = localize('sessions.activity.unavailable', '{0} (coming soon)', label);
		const button = this._register(new Button(container, {
			label: unavailableLabel,
			icon,
			ariaLabel: unavailableLabel,
			title: unavailableLabel,
			enabled: false,
		}));
		button.domNode.classList.add('ash-sessions-activity-item');
	}

	private async showAccountMenu(button: Button): Promise<void> {
		const state = await this.accountService.read();
		const actions = [
			...state.accounts.map(account => {
				const name = account.displayName ?? account.email ?? account.provider;
				const label = account.provider === 'github'
					? localize('workbench.signOutGitHub', 'Sign out of GitHub ({0})', name)
					: localize('workbench.signOutAccount', 'Sign out of {0}', name);
				return {
					id: `ash.sessions.signOut.${account.provider}`,
					label,
					tooltip: label,
					enabled: true,
					run: () => this.accountService.logout(account.provider),
				};
			}),
			{
				id: 'ash.sessions.signIn',
				label: localize('workbench.signInWithChatGPT', 'Sign in with ChatGPT'),
				tooltip: localize('workbench.signInWithChatGPT', 'Sign in with ChatGPT'),
				enabled: true,
				run: () => this.accountService.startLogin({ type: 'openAiChatGptBrowser' as const }),
			},
		];
		button.domNode.setAttribute('aria-expanded', 'true');
		this.contextMenuService.showContextMenu({
			getAnchor: () => button.domNode,
			getActions: () => actions,
			onHide: () => button.domNode.setAttribute('aria-expanded', 'false'),
		});
	}

	public updateHelpHint(hint: string | undefined): void {
		const label = localize('sessions.activity.chat', 'Chat');
		this.chatButton.domNode.setAttribute('aria-label', hint
			? localize('sessions.activity.helpHint', '{0}. {1}', label, hint)
			: label);
	}
}
