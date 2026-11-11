import './media/chatChangesSummaryPart.css';
import { localize } from '../../../../../../nls.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import type { ChatTurnFileChange } from '../../chatResponseFileChangesService.js';
import { ChatCollapsibleContentPart } from './chatCollapsibleContentPart.js';
import { ChatWorkspaceEditContentPart } from './chatWorkspaceEditContentPart.js';

/** Lists the captured files of a completed response and delegates comparison to its host. */
export class ChatCheckpointFileChangesSummaryContentPart extends ChatCollapsibleContentPart {
	private readonly edits: ChatWorkspaceEditContentPart;
	private files: readonly ChatTurnFileChange[] = [];

	constructor(private readonly row: HTMLElement, expanded: boolean, @IInstantiationService instantiation: IInstantiationService) {
		super(row.ownerDocument, 'ash-chat-changed-files');
		this.edits = this._register(instantiation.createInstance(ChatWorkspaceEditContentPart, row.ownerDocument, () => this.changedHeight.fire()));
		this.domNode.hidden = true;
		this.domNode.open = expanded;
		this.domNode.append(this.edits.domNode);
	}

	render(files: readonly ChatTurnFileChange[], beforeLayout?: () => void): boolean {
		const changed = files.length !== this.files.length || files.some((file, index) => {
			const previous = this.files[index];
			return file.id !== previous.id || file.path !== previous.path || file.previousPath !== previous.previousPath
				|| file.kind !== previous.kind || file.additions !== previous.additions || file.deletions !== previous.deletions
				|| file.preview?.revision !== previous.preview?.revision;
		});
		this.files = files;
		if (!changed) {
			if (this.domNode.open) this.edits.render(files);
			return false;
		}
		beforeLayout?.();
		this.summary.textContent = localize('chat.promptTimeline.files', 'Changed files ({0})', files.length);
		const active = this.row.ownerDocument.activeElement as HTMLElement | null;
		const hadFocus = this.domNode.contains(active);
		if (this.domNode.open) this.edits.render(files);
		this.domNode.hidden = files.length === 0;
		if (hadFocus && (this.domNode.hidden || active !== this.row.ownerDocument.activeElement)) {
			const target = this.domNode.hidden ? this.row : active?.isConnected ? active : this.summary;
			target.focus({ preventScroll: true });
		}
		return true;
	}

	protected override expansionDidChange(expanded: boolean): void {
		this.edits.render(expanded ? this.files : []);
	}
}
