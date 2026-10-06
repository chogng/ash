import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { localize } from '../../../../nls.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { ChatAttachmentModel } from './attachments/chatAttachmentModel.js';

/** Acquires file and clipboard content; the shared attachment model owns the resulting entries. */
export class NewChatContextAttachments extends Disposable {
	private readonly filePicker: HTMLInputElement;
	private readonly readers = new Set<FileReader>();

	constructor(
		container: HTMLElement,
		private readonly model: ChatAttachmentModel,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.filePicker = h(container.ownerDocument, 'input');
		this.filePicker.type = 'file';
		this.filePicker.multiple = true;
		this.filePicker.hidden = true;
		this.filePicker.setAttribute('aria-label', localize('chat.attach.files', 'Attach files'));
		container.append(this.filePicker);
		this._register(toDisposable(() => this.filePicker.remove()));
		this._register(toDisposable(() => {
			for (const reader of this.readers) reader.abort();
		}));
		this._register(addDisposableListener(this.filePicker, 'change', () => {
			const files = [...(this.filePicker.files ?? [])];
			this.filePicker.value = '';
			void this.attachFiles(files);
		}));
	}

	public showPicker(): void {
		this.filePicker.click();
	}

	public async attachFiles(files: readonly File[]): Promise<void> {
		try {
			const attachments = await Promise.all(files.map(async file => {
				const image = /^image\/(png|jpeg|gif|webp)$/u.test(file.type);
				const content = await this.readFileContent(file, image);
				if (!image && content.includes('\0')) {
					throw new Error(localize('chat.attach.binary', '{0} must be a UTF-8 text file or a PNG, JPEG, GIF, or WebP image', file.name));
				}
				if (!content.trim()) {
					throw new Error(localize('chat.attach.empty', '{0} is empty', file.name));
				}
				return {
					id: createUuid(),
					kind: image ? 'image' : 'file',
					name: file.name,
					resolve: async () => image ? { name: file.name, content, kind: 'image' as const } : { name: file.name, content },
				};
			}));
			if (!this.isDisposed) {
				this.model.addContext(...attachments);
			}
		} catch (error) {
			if (!this.isDisposed) {
				this.notifications.error(localize('chat.attach.failed', 'Could not attach files: {0}', String(error)));
			}
		}
	}

	private async readFileContent(file: File, image: boolean): Promise<string> {
		const reader = new FileReader();
		const resources = new DisposableStore();
		this.readers.add(reader);
		try {
			return await new Promise<string>((resolve, reject) => {
				resources.add(addDisposableListener(reader, 'load', () => {
					try {
						resolve(image ? String(reader.result) : new TextDecoder('utf-8', { fatal: true }).decode(reader.result as ArrayBuffer));
					} catch {
						reject(new Error(localize('chat.attach.binary', '{0} must be a UTF-8 text file or a PNG, JPEG, GIF, or WebP image', file.name)));
					}
				}));
				resources.add(addDisposableListener(reader, 'error', () => reject(reader.error)));
				resources.add(addDisposableListener(reader, 'abort', () => reject(new CancellationError())));
				if (image) reader.readAsDataURL(file);
				else reader.readAsArrayBuffer(file);
			});
		} finally {
			resources.dispose();
			this.readers.delete(reader);
		}
	}
}
