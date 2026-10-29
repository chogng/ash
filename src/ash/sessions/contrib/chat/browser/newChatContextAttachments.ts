import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';

/** Sessions owns the picker; the shared composer owns reads, validation and cancellation. */
export class NewChatContextAttachments extends Disposable {
	private readonly filePicker: HTMLInputElement;

	constructor(container: HTMLElement, private readonly acquireFiles: (files: readonly File[]) => Promise<void>) {
		super();
		this.filePicker = h(container.ownerDocument, 'input');
		this.filePicker.type = 'file';
		this.filePicker.multiple = true;
		this.filePicker.hidden = true;
		this.filePicker.setAttribute('aria-label', localize('chat.attach.files', 'Attach files'));
		container.append(this.filePicker);
		this._register(toDisposable(() => this.filePicker.remove()));
		this._register(addDisposableListener(this.filePicker, 'change', () => {
			const files = [...(this.filePicker.files ?? [])];
			this.filePicker.value = '';
			void this.attachFiles(files);
		}));
	}

	public showPicker(): void {
		this.filePicker.click();
	}

	public attachFiles(files: readonly File[]): Promise<void> {
		return this.isDisposed ? Promise.resolve() : this.acquireFiles(files);
	}
}
