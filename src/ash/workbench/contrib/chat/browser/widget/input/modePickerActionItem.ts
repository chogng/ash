import type { IAction } from '../../../../../../base/common/actions.js';
import type { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import type { ChatMode } from '../../../../../services/chat/common/chatService.js';
import { ChatSessionPickerActionItem } from '../../chatSessions/chatSessionPickerActionItem.js';

interface IModePickerAction extends IAction {
	readonly actions: readonly IAction[] | (() => Promise<readonly IAction[]>);
}

export type ChatInputMode = ChatMode;

/** Presents the chat input's modes through the shared picker lifecycle and focus contract. */
export class ModePickerActionItem extends ChatSessionPickerActionItem {
	constructor(
		modeAction: IModePickerAction,
		private readonly mode: ChatInputMode,
		captureContext: () => () => boolean,
		onDidSelect: () => void,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(
			modeAction,
			{
				getOptions: () => (typeof modeAction.actions === 'function' ? modeAction.actions() : modeAction.actions),
				captureContext,
				onDidSelect,
			},
			{ className: 'ash-chat-input-mode-menu' },
			instantiationService,
		);
	}

	public override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('ash-chat-input-selector', 'ash-chat-input-mode-selector', 'ash-dropdown-menu-action-view-item', `mode-${this.mode}`);
		container.classList.toggle('disabled', !this.action.enabled);
	}

	protected override renderLabel(element: HTMLElement): IDisposable | null {
		const label = super.renderLabel(element);
		element.classList.add('ash-chat-input-action', 'ash-chat-input-mode-action');
		return label;
	}
}
