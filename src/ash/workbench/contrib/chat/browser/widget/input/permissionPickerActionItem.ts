import type { IAction } from '../../../../../../base/common/actions.js';
import type { Event } from '../../../../../../base/common/event.js';
import type { IManagedHover } from '../../../../../../base/browser/ui/hover/hoverDelegate.js';
import { localize } from '../../../../../../nls.js';
import type { IActionWidgetDropdownActionProvider } from '../../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ChatInputPickerActionViewItem } from './chatInputPickerActionItem.js';

/** Keeps the permission trigger focused while the chat model updates its selection. */
export class PermissionPickerActionItem extends ChatInputPickerActionViewItem {
	private hover: IManagedHover | undefined;

	constructor(
		action: IAction,
		private readonly onDidChange: Event<void>,
		actionProvider: IActionWidgetDropdownActionProvider,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(
			action,
			{ actionProvider, listOptions: { ariaLabel: localize('chat.input.permissions', 'Permissions') } },
			instantiationService,
		);
	}

	public override render(container: HTMLElement): void {
		super.render(container);
		this.element.classList.add('ash-chat-input-permission-picker');
		const update = (): void => {
			this.element.querySelector('.ash-button-label')!.textContent = this.action.label;
			this.element.setAttribute('aria-label', this.action.tooltip);
			this.hover?.update(this.action.tooltip);
			this.updateEnabled();
		};
		this._register(this.onDidChange(update));
		update();
	}

	protected override setupHover(target: HTMLElement, content: string): IManagedHover {
		this.hover = super.setupHover(target, content);
		return this.hover;
	}
}
