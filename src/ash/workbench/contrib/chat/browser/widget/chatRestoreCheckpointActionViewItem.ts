import { Button } from '../../../../../base/browser/ui/button/button.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import type { IChatListItem } from '../../common/model/chatViewModel.js';
import { RestoreCheckpointActionId } from '../chatEditing/chatEditingActions.js';

const contextKeys = new Set([ChatContextKeys.enabled.key]);

/** Restores the checkpoint bound to one request row. */
export class ChatRestoreCheckpointActionViewItem extends Disposable {
	constructor(
		container: HTMLElement,
		source: NonNullable<IChatListItem['requestSource']>,
		isVisible: () => boolean,
		@ICommandService commands: ICommandService,
		@IContextKeyService context: IContextKeyService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		const label = localize('chat.restoreCheckpoint.messageAction', 'Restore checkpoint');
		const button = this._register(new Button(container, {
			...defaultButtonStyles, label, title: label, icon: Lxicon.history, iconOnly: true, presentation: 'quiet', size: 'small',
		}));
		const updateVisibility = () => { button.hidden = context.getValue(ChatContextKeys.enabled.key) !== true; };
		updateVisibility();
		this._register(context.onDidChangeContext(event => {
			if (event.affectsSome(contextKeys)) updateVisibility();
		}));
		const { sessionId, threadId, itemId } = source;
		let pending = false;
		this._register(button.onDidClick(async event => {
			event.stopPropagation();
			if (pending || button.hidden || !isVisible()) return;
			pending = true;
			button.domNode.setAttribute('aria-disabled', 'true');
			try {
				await commands.executeCommand(RestoreCheckpointActionId, { sessionId, threadId, itemId });
			} catch (error) {
				if (!this.isDisposed && !isCancellationError(error)) {
					notifications.error(localize('chat.restoreCheckpoint.failed', 'Could not restore the checkpoint: {0}', String(error)));
				}
			} finally {
				pending = false;
				if (!this.isDisposed) button.domNode.removeAttribute('aria-disabled');
			}
		}));
	}
}
