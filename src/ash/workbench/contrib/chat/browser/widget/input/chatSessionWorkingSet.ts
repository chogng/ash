import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { createUuid } from '../../../../../../base/common/uuid.js';
import { localize } from '../../../../../../nls.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import type { ThreadChangesSummary } from '../../../../../services/chat/common/chatService.js';
import type { ChatChangedFileTarget } from '../../../common/chat.js';
import { ChatWorkspaceEditContentPart } from '../chatContentParts/chatWorkspaceEditContentPart.js';
import { chatInputStackSlotClass, ChatInputStackSlot, setChatInputStackSlot } from './chatInputStack.js';

interface WorkingSetSnapshot {
	readonly owner: string;
	readonly revision: string;
	readonly repositories: ThreadChangesSummary['repositories'];
}

/** Discloses the current conversation's captured files from the composer. */
export class ChatSessionWorkingSet extends Disposable {
	readonly domNode: HTMLElement;
	private readonly toggle: Button;
	private readonly edits: ChatWorkspaceEditContentPart;
	private snapshot: WorkingSetSnapshot | undefined;
	private expanded = false;

	constructor(actions: HTMLElement, private readonly openFile: (revision: string, file: ChatChangedFileTarget) => Promise<void>,
		private readonly focusInput: () => void, @IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		const document = actions.ownerDocument;
		const id = `chat-changed-files-${createUuid()}`;
		const label = localize('chat.changes.reviewFiles', 'Review changed files');
		this.domNode = h(document, 'div', {
			className: `ash-chat-session-working-set ${chatInputStackSlotClass}`,
			attributes: { id, role: 'region', 'aria-label': label },
		});
		this.domNode.hidden = true;
		this.edits = this._register(instantiation.createInstance(ChatWorkspaceEditContentPart, document, () => { }));
		this.domNode.append(this.edits.domNode);
		this.toggle = this._register(new Button(actions, {
			...defaultButtonStyles, label, icon: Lxicon.chevronDown, iconOnly: true, title: label,
			presentation: 'quiet', size: 'small', onClick: () => this.setExpanded(!this.expanded),
		}));
		this.toggle.domNode.setAttribute('aria-controls', id);
		this.toggle.domNode.setAttribute('aria-expanded', 'false');
		this.toggle.hidden = true;
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
			event.preventDefault();
			event.stopPropagation();
			this.toggle.focus();
			this.setExpanded(false);
		}));
		this._register(toDisposable(() => this.domNode.remove()));
	}

	get available(): boolean { return !this.toggle.hidden; }

	render(snapshot: WorkingSetSnapshot | undefined): void {
		if (snapshot?.owner === this.snapshot?.owner && snapshot?.revision === this.snapshot?.revision
			&& snapshot?.repositories === this.snapshot?.repositories) return;
		const active = this.domNode.ownerDocument.activeElement;
		const hadFocus = this.domNode.contains(active) || this.toggle.domNode === active;
		if (snapshot?.owner !== this.snapshot?.owner) this.setExpanded(false);
		this.snapshot = snapshot;
		this.toggle.hidden = !snapshot;
		this.renderFiles();
		if (hadFocus && !snapshot) this.focusInput();
		else if (hadFocus && (this.domNode.hidden || !active?.isConnected)) this.toggle.focus();
	}

	private setExpanded(expanded: boolean): void {
		this.expanded = expanded && this.snapshot !== undefined;
		this.toggle.domNode.setAttribute('aria-expanded', String(this.expanded));
		this.toggle.icon = this.expanded ? Lxicon.chevronUp : Lxicon.chevronDown;
		this.domNode.hidden = !this.expanded;
		setChatInputStackSlot(this.domNode, this.expanded ? ChatInputStackSlot.Standalone : ChatInputStackSlot.Empty);
		this.renderFiles();
	}

	private renderFiles(): void {
		const snapshot = this.expanded ? this.snapshot : undefined;
		this.edits.render(snapshot?.repositories.flatMap(({ repositoryId, files }, index) => {
			const repositoryLabel = snapshot.repositories.length > 1 ? localize('sessions.changes.repository', 'Repository {0}', index + 1) : undefined;
			return files.map(file => ({
				...file, repositoryLabel, id: JSON.stringify([repositoryId, file.path]),
				review: () => {
					if (!this.isDisposed && this.expanded && this.snapshot === snapshot) {
						return this.openFile(snapshot.revision, { repositoryId, path: file.path });
					}
				},
			}));
		}) ?? []);
	}
}
