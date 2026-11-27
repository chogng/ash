import { addDisposableListener } from '../../../../base/browser/dom.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, QuickInputHideReason, QuickInputType, type IQuickPick, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';

interface FilePickerOptions {
	readonly isVisible: () => boolean;
	readonly openFile: (resource: URI) => Promise<void>;
}

/** Runs file Quick Access inline while typing or as a standalone picker. */
export class EmptyFileEditorSearch extends Disposable {
	private readonly input: InputBox;
	private picker: IQuickPick<IQuickPickItem> | undefined;

	constructor(
		container: HTMLElement,
		private readonly options: FilePickerOptions,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		const searchLabel = localize('sessions.emptyFileEditor.searchFiles', 'Search files');
		const input = this.input = this._register(new InputBox(container, {
			inputBoxStyles: defaultInputBoxStyles, presentation: 'field', ariaLabel: searchLabel, placeholder: searchLabel,
		}));
		const field = input.inputElement;
		const showInline = () => {
			if (!this.picker && input.hasFocus() && input.value.trim()) this.showPicker(field);
		};
		this._register(addDisposableListener(field, 'focus', showInline));
		this._register(addDisposableListener(field, 'input', event => {
			if (!(event as InputEvent).isComposing) showInline();
		}));
		// Keep native input method composition on the original field until it commits.
		this._register(addDisposableListener(field, 'compositionend', () => queueMicrotask(showInline)));
	}

	show(): void { this.showPicker(); }

	private showPicker(anchor?: HTMLInputElement): void {
		if (this.isDisposed || !this.options.isVisible()) return;
		const value = anchor?.value ?? '';
		const selection = anchor && { start: anchor.selectionStart ?? value.length, end: anchor.selectionEnd ?? value.length };
		this.quickInput.quickAccess.show(value, {
			anchor,
			anchorPosition: anchor ? 'overlay' : undefined,
			placeholder: this.input.placeholder,
			enabledProviderPrefixes: [''],
			providerOptions: {
				handleAccept: item => {
					if (this.isDisposed || !this.options.isVisible() || !('resource' in item) || !URI.isUri(item.resource)) return;
					this.picker?.hide();
					void this.options.openFile(item.resource).catch(error => this.notifications.error(error));
				},
			},
		});
		const picker = this.quickInput.currentQuickInput;
		if (picker?.type !== QuickInputType.QuickPick) return;
		this.picker = picker as IQuickPick<IQuickPickItem>;
		Event.once(picker.onDidHide)(() => { this.picker = undefined; });
		if (!selection) return;

		const inlinePicker = this.picker;
		inlinePicker.valueSelection = selection;
		this.input.element.classList.add('has-inline-results');
		inlinePicker.onDidChangeValue(query => {
			if (!query.trim()) inlinePicker.hide();
		});
		Event.once(inlinePicker.onWillHide)(({ reason }) => {
			// Reveal the anchor before Quick Input restores focus to it.
			this.input.element.classList.remove('has-inline-results');
			this.input.value = reason === QuickInputHideReason.Blur ? inlinePicker.value : '';
		});
	}

	focus(): void { this.input.focus(); }
	clear(): void {
		this.picker?.hide();
		this.input.value = '';
	}

	protected override disposeCore(): void {
		this.clear();
		super.disposeCore();
	}
}
