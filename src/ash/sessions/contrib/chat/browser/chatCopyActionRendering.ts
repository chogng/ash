import { h } from '../../../../base/browser/dom.js';
import type { ActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { MenuId, MenuItemAction } from '../../../../platform/actions/common/actions.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { CopyCodeBlockActionId } from '../../../../workbench/contrib/chat/browser/actions/chatCodeblockActions.js';
import { CopyItemActionId } from '../../../../workbench/contrib/chat/browser/actions/chatCopyActions.js';
import { ChatMessageActionContext } from '../../../../workbench/contrib/chat/browser/chat.js';
import { CopyActionViewItem, type CopyActionOperation } from '../../../../workbench/contrib/chat/browser/widget/copyActionViewItem.js';

class ChatCopyActionViewItem extends CopyActionViewItem {
	private status: HTMLElement | undefined;

	constructor(
		action: MenuItemAction,
		options: ActionViewItemOptions,
		@IAccessibilityService private readonly accessibility: IAccessibilityService,
	) {
		super(action, options);
	}

	protected override setupTooltip(): void {
		this.button.setTitle(localize('chat.message.copyTooltip', 'Copy'));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		const row = this.actionContext;
		const status = this.status = h(container.ownerDocument, 'span', { className: 'ash-chat-message-copy-status', attributes: { role: 'status' } });
		(row instanceof ChatMessageActionContext ? row.actions : container).append(status);
		this._register(toDisposable(() => status.remove()));
	}

	override setActionContext(context: unknown): void {
		super.setActionContext(context);
		if (this.status && context instanceof ChatMessageActionContext && this.status.parentElement !== context.actions) {
			context.actions.append(this.status);
		}
	}

	protected override getCopyOperation(): CopyActionOperation | undefined {
		const row = this.actionContext;
		const status = this.status;
		if (!(row instanceof ChatMessageActionContext) || !status) return undefined;
		const item = row.item;
		return {
			isCurrent: () => row.visible && row.item === item && !!item.text,
			run: () => {
				status.textContent = '';
				return this.action.run(item);
			},
			onSuccess: () => this.accessibility.status(localize('chat.message.copied', 'Message copied.')),
			onError: error => { status.textContent = localize('chat.message.copyFailed', 'Could not copy message: {0}', String(error)); },
		};
	}
}

export class SessionsChatCopyActionRendering extends Disposable {
	static readonly ID = 'sessions.chat.copyActionRendering';

	constructor(
		@IActionViewItemService presentations: IActionViewItemService,
		@IAccessibilityService accessibility: IAccessibilityService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		for (const menu of [MenuId.ChatMessageTitle, MenuId.ChatMessageFooter]) {
			this._register(presentations.register(menu, CopyItemActionId, (action, options, instantiation) =>
				action instanceof MenuItemAction ? instantiation.createInstance(ChatCopyActionViewItem, action, options) : undefined));
		}
		this._register(presentations.register(MenuId.ChatCodeBlockToolbar, CopyCodeBlockActionId, (action, options) =>
			new CopyActionViewItem(action, options, () => ({
				run: () => action.run(),
				onSuccess: () => accessibility.status(localize('chat.code.copied', 'Code copied.')),
				onError: error => {
					if (!isCancellationError(error)) notifications.error(localize('chat.code.failed', 'Could not perform the code block action: {0}', String(error)));
				},
			}), options.iconOnly === false ? 'small' : undefined)));
	}
}
