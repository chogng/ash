import './media/titleMenuActionViewItem.css';
import { addDisposableListener, isElement, stopEvent } from '../../../../base/browser/dom.js';
import type { Button, IButtonOptions } from '../../../../base/browser/ui/button/button.js';
import { ContextViewHideReason } from '../../../../base/browser/ui/contextview/contextview.js';
import { DropdownMenuActionViewItem } from '../../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js';
import type { IAction } from '../../../../base/common/actions.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import type { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';

const doubleClickDelay = 500;

/** A dropdown action rendered as a Sessions title. The owner supplies the current target's actions. */
export class TitleMenuActionViewItem extends DropdownMenuActionViewItem {
	private readonly clickTimer = this._register(new RunOnceScheduler(() => this.show(), doubleClickDelay));
	private trigger!: Button;

	constructor(action: IAction, getActions: () => readonly IAction[], contextMenus: IContextMenuService,
		private readonly getRenameAction: () => (() => void) | undefined) {
		super(action, getActions, {
			showContextMenu: delegate => contextMenus.showContextMenu({
				...delegate,
				iconPlacement: 'leading-with-trailing-check',
				onHide: (cancelled, reason) => {
					delegate.onHide?.(cancelled, reason);
					if (reason === ContextViewHideReason.Escape && this.element.isConnected) this.focus();
				},
			}),
		}, { buttonStyles: defaultButtonStyles, buttonPresentation: 'quiet' });
	}

	get element(): HTMLButtonElement { return this.trigger.domNode; }

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('ash-title-menu');
	}

	protected override createButton(container: HTMLElement, options: IButtonOptions): Button {
		const button = this.trigger = super.createButton(container, {
			...options,
			size: 'small',
			onClick: event => {
				const onIndicator = isElement(event.target) && event.target.closest('.ash-dropdown-menu-indicator');
				const rename = this.getRenameAction();
				if (!rename || onIndicator || event.detail === 0 || event.pointerType === 'touch') {
					this.clickTimer.cancel();
					options.onClick?.(event);
				} else if (event.detail === 1) {
					// A context menu captures the next pointer click, so let a double-click resolve first.
					this.clickTimer.schedule();
				} else if (event.detail === 2 && this.clickTimer.isScheduled()) {
					this.hide();
					rename();
				}
			},
		});
		button.domNode.classList.add('ash-title-menu-trigger', 'ash-titlebar-interactive-region');
		this._register(addDisposableListener(button.domNode, 'keydown', event => {
			if (event.key === 'Escape') this.clickTimer.cancel();
			if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
			stopEvent(event);
			this.show(true);
		}));
		this._register(addDisposableListener(button.domNode, 'blur', () => this.clickTimer.cancel()));
		return button;
	}

	override show(autoSelectFirstItem = false): void {
		this.clickTimer.cancel();
		super.show(autoSelectFirstItem);
	}

	override hide(): void {
		this.clickTimer.cancel();
		super.hide();
	}
}
