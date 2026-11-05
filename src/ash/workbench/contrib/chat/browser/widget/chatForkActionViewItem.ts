import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { createPixelSpinner, type IPixelSpinner } from '../../../../../base/browser/ui/pixelSpinner/pixelSpinner.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { ForkConversationActionId, type IForkConversationOptions } from '../actions/chatForkActions.js';

const enabledContext = new Set([ChatContextKeys.enabled.key]);

/** Owns the message button and its progress feedback for the lifetime of the rendered row. */
export class ChatForkActionViewItem extends Disposable {
	private readonly button: Button;
	private readonly spinner = this._register(new MutableDisposable<IPixelSpinner>());
	private readonly label = localize('chat.forkConversation.tooltip', 'Fork conversation from this point');

	constructor(
		container: HTMLElement,
		private readonly source: Omit<IForkConversationOptions, 'toSide'>,
		private readonly isVisible: () => boolean,
		@ICommandService private readonly commands: ICommandService,
		@IContextKeyService contextKeys: IContextKeyService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.button = this._register(new Button(container, {
			...defaultButtonStyles,
			label: this.label,
			title: this.label,
			icon: Lxicon.fork,
			iconOnly: true,
			presentation: 'quiet',
			size: 'small',
		}));
		this.button.domNode.classList.add('ash-chat-fork-action');
		const updateVisibility = () => { this.button.hidden = contextKeys.getValue(ChatContextKeys.enabled.key) !== true; };
		updateVisibility();
		this._register(contextKeys.onDidChangeContext(event => {
			if (event.affectsSome(enabledContext)) updateVisibility();
		}));
		this._register(this.button.onDidClick(event => {
			event.stopPropagation();
			void this.run(event.altKey);
		}));
		this._register(addDisposableListener(this.button.domNode, 'keydown', event => {
			if (!event.altKey || event.isComposing || (event.key !== 'Enter' && event.key !== ' ')) return;
			event.preventDefault();
			event.stopPropagation();
			if (!event.repeat) void this.run(true);
		}));
	}

	private async run(toSide: boolean): Promise<void> {
		if (this.spinner.value || this.button.hidden || !this.isVisible()) return;
		const progress = localize('chat.forkConversation.running', 'Forking conversation');
		const button = this.button.domNode;
		this.spinner.value = createPixelSpinner(button, { variant: 'ring' });
		button.setAttribute('aria-busy', 'true');
		button.setAttribute('aria-disabled', 'true');
		this.button.setTitle(progress);
		status(progress);
		try {
			await this.commands.executeCommand(ForkConversationActionId, { ...this.source, toSide });
		} catch (error) {
			if (!this.isDisposed && !isCancellationError(error)) {
				this.notifications.error(localize('chat.forkConversation.failed', 'Could not fork the conversation: {0}', String(error)));
			}
		} finally {
			if (!this.isDisposed) {
				this.spinner.clear();
				button.removeAttribute('aria-busy');
				button.removeAttribute('aria-disabled');
				this.button.setTitle(this.label);
			}
		}
	}
}
