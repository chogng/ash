import './media/sessionView.css';
import { addDisposableListener, h } from '../../../base/browser/dom.js';
import type { IView } from '../../../base/browser/ui/grid/grid.js';
import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import type { IOpenAgentsWindowOptions } from '../../../platform/native/common/nativeHost.js';
import type { ChatContextAttachment } from '../../../workbench/services/chat/common/chatContextService.js';
import type { ChatMode } from '../../../workbench/services/chat/common/chatService.js';
import type { SessionId, IActiveSessionThread, IUntitledChatSession } from '../../services/sessions/common/session.js';
import type { SessionsViewSelection } from '../../services/sessions/browser/sessionsService.js';
import type { SessionsConversationKind } from '../../services/sessions/common/sessionsConversation.js';

export interface ISessionsConversationPane extends IDisposable {
	readonly element: HTMLElement;
	readonly sessionId: SessionId | undefined;
	readonly model: {
		readonly inputState: { readonly mode: ChatMode; };
		selectThread(active: IActiveSessionThread): Promise<void>;
		selectUntitledSession(session: IUntitledChatSession): void;
	};
	focus(): void;
	startVoiceConversation(): Promise<void>;
	addContext(attachment: ChatContextAttachment): void;
	appendToDraft(text: string): void;
	captureDraft(): Promise<{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void; } | undefined>;
	restoreDraft(draft: NonNullable<IOpenAgentsWindowOptions['draft']>): void;
	setVisible(visible: boolean): void;
}

interface ISessionViewOptions {
	readonly selection: SessionsViewSelection;
	readonly kind: SessionsConversationKind;
	readonly createPane: (kind: SessionsConversationKind, container: HTMLElement, panelId: string, selection: SessionsViewSelection) => ISessionsConversationPane;
	readonly activateSelection: (selection: SessionsViewSelection) => void;
}

let nextChatPaneId = 0;

/** One Session's retained chat surface, shared by the Chat and Code compositions. */
export class SessionView extends Disposable implements IView {
	readonly element: HTMLElement;
	readonly minimumWidth = 300;
	readonly maximumWidth = Number.POSITIVE_INFINITY;
	readonly minimumHeight = 240;
	readonly maximumHeight = Number.POSITIVE_INFINITY;
	private readonly panes = new Map<SessionsConversationKind, ISessionsConversationPane>();
	private selection: SessionsViewSelection;
	private kind: SessionsConversationKind;
	private visible = true;
	private selectionRevision = 0;

	constructor(container: HTMLElement, private readonly options: ISessionViewOptions) {
		super();
		this.selection = options.selection;
		this.kind = options.kind;
		this.element = h(container.ownerDocument, 'article');
		this.element.className = 'ash-sessions-chat-slot';
		this.attachPane(this.getOrCreatePane(this.kind));
		const activate = () => {
			if (!this.element.classList.contains('active')) options.activateSelection(this.selection);
		};
		this._register(addDisposableListener(this.element, 'focusin', activate));
		this._register(addDisposableListener(this.element, 'pointerdown', activate));
		this._register(toDisposable(() => this.element.remove()));
	}

	get activeChat(): ISessionsConversationPane { return this.panes.get(this.kind)!; }

	openSession(selection: SessionsViewSelection): void {
		const previousThread = this.selection.kind === 'session' ? this.selection.active.threadId : this.selection.session.untitledSessionId;
		const nextThread = selection.kind === 'session' ? selection.active.threadId : selection.session.untitledSessionId;
		if (previousThread !== nextThread) this.selectionRevision++;
		this.selection = selection;
		for (const pane of this.panes.values()) this.updatePane(pane);
	}

	async setConversationKind(kind: SessionsConversationKind): Promise<void> {
		if (kind === this.kind || this.isDisposed) return;
		const revision = this.selectionRevision;
		const previous = this.activeChat;
		const draft = await previous.captureDraft();
		if (this.isDisposed) return;
		const next = this.getOrCreatePane(kind);
		const oldDraft = await next.captureDraft();
		if (this.isDisposed) return;
		if (revision !== this.selectionRevision) return this.setConversationKind(kind);
		const focused = this.element.contains(this.element.ownerDocument.activeElement);
		// Only the displayed chat owns the unsent draft. Retained renderers keep their
		// DOM and transcript view state, without reviving an older composer on return.
		oldDraft?.clear();
		draft?.clear();
		next.restoreDraft(draft?.draft ?? { mode: previous.model.inputState.mode, text: '', contexts: [] });
		previous.setVisible(false);
		previous.element.remove();
		this.kind = kind;
		this.attachPane(next);
		if (focused && this.visible) next.focus();
	}

	focus(): void { this.activeChat.focus(); }
	layout(_bounds: Parameters<IView['layout']>[0]): void { }

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.activeChat.setVisible(visible);
	}

	private getOrCreatePane(kind: SessionsConversationKind): ISessionsConversationPane {
		let pane = this.panes.get(kind);
		if (!pane) {
			pane = this._register(this.options.createPane(kind, this.element, `ash-sessions-conversation-pane-${++nextChatPaneId}`, this.selection));
			pane.element.setAttribute('role', 'region');
			pane.setVisible(false);
			pane.element.remove();
			this.panes.set(kind, pane);
			this.updatePane(pane);
		}
		return pane;
	}

	private attachPane(pane: ISessionsConversationPane): void {
		this.element.dataset.conversationKind = this.kind;
		this.element.append(pane.element);
		pane.setVisible(this.visible);
	}

	private updatePane(pane: ISessionsConversationPane): void {
		if (this.selection.kind === 'session') {
			void pane.model.selectThread(this.selection.active).catch(error => console.error('Failed to select Sessions Chat thread', error));
		} else {
			pane.model.selectUntitledSession(this.selection.session);
		}
		const session = this.selection.kind === 'session' ? this.selection.active.session : this.selection.session;
		pane.element.setAttribute('aria-label', session.title.trim() || localize('sessions.conversation.editorName', 'Session'));
	}
}
