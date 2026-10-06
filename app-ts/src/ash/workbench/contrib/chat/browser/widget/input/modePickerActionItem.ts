import { h } from '../../../../../../base/browser/dom.js';
import { appendIcon } from '../../../../../../base/browser/ui/lxicons/lxicon.js';
import { Separator, type IAction } from '../../../../../../base/common/actions.js';
import type { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import type { ChatMode } from '../../../../../services/chat/common/chatService.js';
import { ChatInputPickerActionViewItem } from './chatInputPickerActionItem.js';

interface IModePickerAction extends IAction {
	readonly actions: readonly IAction[] | (() => Promise<readonly IAction[]>);
}

export type ChatInputMode = ChatMode;

/** Presents the chat input's modes through the shared picker lifecycle and focus contract. */
export class ModePickerActionItem extends ChatInputPickerActionViewItem {
	constructor(modeAction: IModePickerAction, private readonly mode: ChatInputMode, onDidSelect: () => void, @IInstantiationService instantiationService: IInstantiationService) {
		super(modeAction, {
			actionProvider: {
				getActions: async () => {
					const actions = typeof modeAction.actions === 'function' ? await modeAction.actions() : modeAction.actions;
					return actions.map(action => action instanceof Separator ? action : {
						...action,
						run: async () => {
							await action.run();
							onDidSelect();
						},
					});
				},
			},
			listOptions: { className: 'ash-chat-input-mode-menu' },
		}, instantiationService);
	}

	public override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('ash-chat-input-selector', 'ash-chat-input-mode-selector', 'ash-dropdown-menu-action-view-item', `mode-${this.mode}`);
		container.classList.toggle('disabled', !this.action.enabled);
	}

	protected override renderLabel(element: HTMLElement): IDisposable | null {
		const label = super.renderLabel(element);
		element.classList.add('ash-chat-input-action', 'ash-chat-input-mode-action');
		element.querySelector('.ash-button-label')!.classList.add('ash-chat-input-mode-action-label');
		element.setAttribute('aria-label', this.action.tooltip);
		const indicator = h(element.ownerDocument, 'span');
		indicator.className = 'ash-dropdown-menu-indicator ash-chat-input-mode-indicator';
		indicator.setAttribute('aria-hidden', 'true');
		appendIcon(Lxicon.chevronDown, indicator);
		element.append(indicator);
		return label;
	}
}
