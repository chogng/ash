import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';

/** Handles file drops on a composer without intercepting editor text dragging. */
export class ChatDragAndDrop extends Disposable {
	constructor(private readonly acceptFiles: (files: readonly File[]) => Promise<void>) {
		super();
	}

	public addOverlay(target: HTMLElement, overlayContainer: HTMLElement): void {
		const resources = this._register(new DisposableStore());
		const overlay = h(target.ownerDocument, 'div');
		overlay.className = 'ash-chat-drop-overlay';
		overlay.textContent = localize('chat.attach.drop', 'Drop files to attach');
		overlay.hidden = true;
		overlayContainer.append(overlay);
		resources.add(toDisposable(() => overlay.remove()));
		resources.add(addDisposableListener(target, 'dragover', event => {
			if (!event.dataTransfer?.types.includes('Files')) {
				return;
			}
			event.preventDefault();
			event.dataTransfer.dropEffect = 'copy';
			overlay.hidden = false;
		}));
		resources.add(addDisposableListener(target, 'dragleave', event => {
			if (!target.contains(event.relatedTarget as Node | null)) {
				overlay.hidden = true;
			}
		}));
		resources.add(addDisposableListener(target, 'drop', event => {
			overlay.hidden = true;
			const files = [...(event.dataTransfer?.files ?? [])];
			if (files.length === 0) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			void this.acceptFiles(files);
		}, true));
	}
}
