import type { IAction } from '../../../../../../base/common/actions.js';
import type { IDisposable } from '../../../../../../base/common/lifecycle.js';
import type { IManagedHover } from '../../../../../../base/browser/ui/hover/hoverDelegate.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import type { ChatAgent } from '../../../../../services/chat/common/chatService.js';
import { ChatSessionPickerActionItem } from '../../chatSessions/chatSessionPickerActionItem.js';
import { ChatAgentHover } from '../chatAgentHover.js';

interface IAgentPickerAction extends IAction {
	readonly actions: readonly IAction[] | (() => Promise<readonly IAction[]>);
}

/** Presents the available Agents through the shared picker lifecycle and focus contract. */
export class AgentPickerActionItem extends ChatSessionPickerActionItem {
	private agentHover: IManagedHover | undefined;

	constructor(
		agentAction: IAgentPickerAction,
		captureContext: () => () => boolean,
		onDidSelect: () => void,
		private readonly getAgent: () => ChatAgent | undefined,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(agentAction, {
			getOptions: () => typeof agentAction.actions === 'function' ? agentAction.actions() : agentAction.actions,
			captureContext,
			onDidSelect,
		}, {
			className: 'ash-chat-input-agent-menu ash-action-widget-accent-checks',
			menuIconPlacement: 'leading-with-trailing-check',
		}, instantiationService);
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
		container.classList.add('ash-chat-input-selector', 'ash-chat-input-agent-selector', 'ash-dropdown-menu-action-view-item');
		container.classList.toggle('disabled', !this.action.enabled);
	}

	public setCompact(compact: boolean): void {
		this.element.classList.toggle('icon-only', compact);
	}

	protected override renderLabel(element: HTMLElement): IDisposable | null {
		const label = super.renderLabel(element);
		element.classList.add('ash-chat-input-action', 'ash-chat-input-agent-action');
		return label;
	}
}
