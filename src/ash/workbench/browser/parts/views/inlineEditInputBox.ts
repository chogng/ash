import { addDisposableListener } from '../../../../base/browser/dom.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import Severity from '../../../../base/common/severity.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import type { IEditableData } from '../../../common/views.js';

export interface IInlineEditInputBoxOptions {
	readonly ariaLabel: string;
	readonly value?: string;
	readonly selection?: { readonly start: number; readonly end: number; };
}

/** Owns one temporary input, with one terminal submit/cancel callback. */
export class InlineEditInputBox extends Disposable {
	public readonly inputBox: InputBox;
	private menuOpen = false;
	private finished = false;

	constructor(
		container: HTMLElement,
		private readonly editableData: IEditableData,
		options: IInlineEditInputBoxOptions,
		@IContextMenuService contextMenus: IContextMenuService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.inputBox = this._register(new InputBox(container, {
			inputBoxStyles: defaultInputBoxStyles,
			presentation: 'compact',
			ariaLabel: options.ariaLabel,
			placeholder: editableData.placeholder ?? undefined,
		}));
		this.inputBox.element.classList.add('ash-inline-edit-input');
		this.inputBox.value = options.value ?? editableData.startingValue ?? '';
		this._register(this.inputBox.onDidChange(() => this.validate()));
		this._register(this.inputBox.onKeyDown(event => {
			event.stopPropagation();
			if (event.isComposing) { return; }
			if (event.key === 'Enter' || event.key === 'Escape') {
				event.preventDefault();
				this.finish(event.key === 'Enter');
			}
		}));
		this._register(this.inputBox.onDidBlur(() => {
			if (!this.menuOpen) { this.finish(this.validate()); }
		}));
		this._register(contextMenus.onDidShowContextMenu(() => {
			this.menuOpen = container.contains(container.ownerDocument.activeElement);
		}));
		this._register(contextMenus.onDidHideContextMenu(() => {
			const restoreFocus = this.menuOpen;
			this.menuOpen = false;
			if (restoreFocus && !this.isDisposed) { this.inputBox.focus(); }
		}));
		this._register(addDisposableListener(container, 'submit', event => {
			event.preventDefault();
			this.finish(true);
		}));
		this.inputBox.focus();
		if (options.selection) {
			this.inputBox.inputElement.setSelectionRange(options.selection.start, options.selection.end);
		} else { this.inputBox.select(); }
		this.validate();
	}

	private validate(): boolean {
		const message = this.editableData.validationMessage(this.inputBox.value);
		this.inputBox.showValidation(message?.content ?? '');
		return message?.severity !== Severity.Error;
	}

	private finish(success: boolean): void {
		if (this.finished || this.isDisposed || success && !this.validate()) { return; }
		this.finished = true;
		const value = this.inputBox.value;
		this.dispose();
		void this.editableData.onFinish(value, success).catch(error => this.notifications.error(error));
	}
}
