import { MenuEntryActionViewItem, type IMenuEntryActionViewItemOptions } from '../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import type { MenuItemAction } from '../../../../../platform/actions/common/actions.js';
import type { IObservable } from '../../../../../base/common/observable.js';
import { autorun } from '../../../../../base/common/observable.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { addMicButtonContextMenuListener, getDictationContextMenuActions } from './micButtonMenuActions.js';

/** The ActionBar owns this button's lifetime; the editor session owns its action and state. */
export class DictationActionViewItem extends MenuEntryActionViewItem {
	constructor(action: MenuItemAction, options: IMenuEntryActionViewItemOptions | undefined, private readonly isActive: IObservable<boolean>,
		@ICommandService private readonly commands: ICommandService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IKeybindingService private readonly keybindings: IKeybindingService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
	) {
		super(action, options);
	}

	public override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('ash-chat-input-mic');
		container.classList.toggle('disabled', !this.action.enabled);
		this.button.toggleClassName('ash-chat-input-action', true);
		this.button.toggleClassName('ash-chat-input-mic-action', true);
		this.button.toggleClassName('disabled', !this.action.enabled);
		this._register(autorun(reader => this.button.domNode.setAttribute('aria-pressed', String(this.isActive.read(reader)))));
		this._register(addMicButtonContextMenuListener(container, () => getDictationContextMenuActions(this.commands, this.configuration, this.keybindings, this.action.id), this.contextMenus));
	}
}
