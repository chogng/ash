import { h } from '../../../../../../base/browser/dom.js';
import { Disposable, DisposableMap } from '../../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import type { ChatTurnFileChange } from '../../chatResponseFileChangesService.js';
import { ChatEditPillElement } from './chatEditPillElement.js';

/** Presents captured workspace changes using the existing per-file review and diff controls. */
export class ChatWorkspaceEditContentPart extends Disposable {
	readonly domNode: HTMLUListElement;
	private readonly rows = this._register(new DisposableMap<string, ChatEditPillElement>());

	constructor(document: Document, private readonly onDidChangeHeight: () => void,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		this.domNode = h(document, 'ul', { className: 'ash-chat-changed-file-list' });
	}

	render(files: readonly ChatTurnFileChange[]): void {
		const ids = new Set(files.map(file => file.id));
		for (const id of this.rows.keys()) {
			if (!ids.has(id)) this.rows.deleteAndDispose(id);
		}
		let next = this.domNode.firstChild;
		for (const file of files) {
			let row = this.rows.get(file.id);
			if (!row) {
				row = this.instantiation.createInstance(ChatEditPillElement, this.domNode.ownerDocument, this.onDidChangeHeight);
				this.rows.set(file.id, row);
			}
			row.render(file);
			if (row.item !== next) this.domNode.insertBefore(row.item, next);
			next = row.item.nextSibling;
		}
	}
}
