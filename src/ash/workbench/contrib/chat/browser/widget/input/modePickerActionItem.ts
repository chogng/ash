import type { IAction } from '../../../../../../base/common/actions.js';
import type { IDisposable } from '../../../../../../base/common/lifecycle.js';
import type { IManagedHover } from '../../../../../../base/browser/ui/hover/hoverDelegate.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import type { ChatAgent, ChatMode } from '../../../../../services/chat/common/chatService.js';
import { ChatSessionPickerActionItem } from '../../chatSessions/chatSessionPickerActionItem.js';
import { ChatAgentHover } from '../chatAgentHover.js';

interface IModePickerAction extends IAction {
	readonly actions: readonly IAction[] | (() => Promise<readonly IAction[]>);
}

export type ChatInputMode = ChatMode;

/** Presents the chat input's modes through the shared picker lifecycle and focus contract. */
export class ModePickerActionItem extends ChatSessionPickerActionItem {
	private agentHover: IManagedHover | undefined;

	constructor(
		modeAction: IModePickerAction,
		private readonly mode: ChatInputMode,
		captureContext: () => () => boolean,
		onDidSelect: () => void,
		private readonly getAgent: () => ChatAgent | undefined,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(modeAction, {
			getOptions: () => typeof modeAction.actions === 'function' ? modeAction.actions() : modeAction.actions,
			captureContext,
			onDidSelect,
		}, { className: 'ash-chat-input-mode-menu' }, instantiationService);
	}

	protected override setupHover(target: HTMLElement, content: string): IManagedHover {
		const managed = this.agentHover = super.setupHover(target, content);
		managed.update(() => {
			const agent = this.getAgent();
			if (!agent) {
				return content;
			}
			const hover = new ChatAgentHover(target.ownerDocument);
			hover.setAgent(agent);
			return hover.domNode;
		});
		return managed;
	}

	public override hide(): void {
		this.agentHover?.hide();
		super.hide();
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
