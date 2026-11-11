import { h } from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { localize } from '../../../../../../nls.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import type { ChatTurnFileChange } from '../../chatResponseFileChangesService.js';
import { ChatTextEditContentPart } from './chatTextEditContentPart.js';
import './media/chatEditStatsButton.css';

/** Owns one file's review link, line counts and optional inline comparison. */
export class ChatEditPillElement extends Disposable {
	readonly item: HTMLLIElement;
	private readonly actions: HTMLElement;
	private readonly review: Button;
	private readonly added: HTMLElement;
	private readonly removed: HTMLElement;
	private readonly preview = this._register(new MutableDisposable<ChatTextEditContentPart>());
	private file: ChatTurnFileChange | undefined;

	constructor(document: Document, private readonly onDidChangeHeight: () => void, @IInstantiationService private readonly instantiation: IInstantiationService) {
		super();
		this.item = h(document, 'li');
		this.actions = h(document, 'div', { className: 'ash-chat-edit-file-actions' });
		this.item.append(this.actions);
		this.review = this._register(new Button(this.actions, { ...defaultButtonStyles, label: '', icon: Lxicon.file, presentation: 'quiet', size: 'small' }));
		this.review.domNode.classList.add('ash-chat-changed-file');
		this.added = h(document, 'span', { className: 'ash-changes-stats-added' });
		this.removed = h(document, 'span', { className: 'ash-changes-stats-removed' });
		this.review.domNode.append(h(document, 'span', { className: 'ash-changes-stats', attributes: { 'aria-hidden': 'true' } }, this.added, ' ', this.removed));
		this._register(this.review.onDidClick(() => { void this.file?.review(); }));
		this._register(toDisposable(() => this.item.remove()));
	}

	render(file: ChatTurnFileChange): void {
		const previous = this.file;
		this.file = file;
		if (!previous || previous.path !== file.path || previous.previousPath !== file.previousPath
			|| previous.repositoryLabel !== file.repositoryLabel || previous.kind !== file.kind
			|| previous.additions !== file.additions || previous.deletions !== file.deletions) {
			const path = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
			const label = file.repositoryLabel ? localize('chat.changes.repositoryFile', '{0} · {1}', file.repositoryLabel, path) : path;
			if (this.review.label !== label) {
				this.review.label = label;
				this.review.setTitle(label);
			}
			this.review.domNode.setAttribute('aria-label', localize('chat.turnChanges.openFile', 'Open changes for {0}, added {1}, removed {2}', label, file.additions, file.deletions));
			const edit = describeWorkspaceEdit(file.kind);
			this.review.icon = edit?.icon ?? Lxicon.file;
			if (edit) this.review.domNode.setAttribute('aria-description', edit.label);
			else this.review.domNode.removeAttribute('aria-description');
			this.added.textContent = `+${file.additions}`;
			this.removed.textContent = `−${file.deletions}`;
		}
		if (!file.preview) {
			this.preview.clear();
			return;
		}
		const previewFile = { ...file, preview: file.preview };
		if (this.preview.value && file.preview.revision === previous?.preview?.revision && file.path === previous?.path) {
			this.preview.value.updateFile(previewFile);
		} else {
			this.preview.value = this.instantiation.createInstance(ChatTextEditContentPart, this.actions, this.item, previewFile, this.onDidChangeHeight);
		}
	}
}

function describeWorkspaceEdit(kind: ChatTurnFileChange['kind']) {
	switch (kind) {
		case 'added': return { icon: Lxicon.newFile, label: localize('chat.workspaceEdit.created', 'Created file') };
		case 'deleted': return { icon: Lxicon.trash, label: localize('chat.workspaceEdit.deleted', 'Deleted file') };
		case 'renamed': return { icon: Lxicon.arrowRight, label: localize('chat.workspaceEdit.renamed', 'Renamed file') };
		case 'typeChanged': return { icon: Lxicon.file, label: localize('chat.workspaceEdit.typeChanged', 'File type changed') };
		case 'modified':
		case undefined: return undefined;
	}
}
