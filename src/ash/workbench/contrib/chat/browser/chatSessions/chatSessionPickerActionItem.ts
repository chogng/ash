import './media/chatSessionPickerActionItem.css';
import { Separator, type IAction } from '../../../../../base/common/actions.js';
import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import type { IActionListOptions } from '../../../../../platform/actionWidget/browser/actionList.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ChatInputPickerActionViewItem } from '../widget/input/chatInputPickerActionItem.js';

/** Options and selection belong to the originating composer's provider. */
export interface IChatSessionPickerDelegate {
	getOptions(): readonly IAction[] | Promise<readonly IAction[]>;
	/** Capture before an asynchronous option read, including leave-and-return navigation. */
	captureContext(): () => boolean;
	onDidSelect(): void;
}

/** Presents session options using the input's existing popup and focus owner. */
export class ChatSessionPickerActionItem extends ChatInputPickerActionViewItem {
	constructor(action: IAction, delegate: IChatSessionPickerDelegate, listOptions: IActionListOptions, @IInstantiationService instantiationService: IInstantiationService) {
		super(action, {
			actionProvider: {
				getActions: async () => {
					const isCurrent = delegate.captureContext();
					const options = await delegate.getOptions();
					if (this.isDisposed || !isCurrent()) return [];
					return options.map(option => option instanceof Separator ? option : {
						...option,
						run: async () => {
							if (this.isDisposed || !isCurrent() || !option.enabled) return;
							await option.run();
							if (!this.isDisposed && isCurrent()) delegate.onDidSelect();
						},
					});
				},
			},
			listOptions,
		}, instantiationService);
	}

	public override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('ash-chat-session-picker');
	}

	protected override renderLabel(element: HTMLElement): IDisposable | null {
		const label = super.renderLabel(element);
		element.classList.add('ash-chat-input-session-action');
		element.querySelector('.ash-button-label')!.classList.add('ash-chat-input-session-action-label');
		element.setAttribute('aria-label', this.action.tooltip);
		return label;
	}
}
