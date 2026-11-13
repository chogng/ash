import './media/sessionView.css';
import { addDisposableListener, h } from '../../../base/browser/dom.js';
import { Button } from '../../../base/browser/ui/button/button.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { defaultButtonStyles } from '../../../platform/theme/browser/defaultStyles.js';
import type { IView } from '../../../base/browser/ui/grid/grid.js';
import { Disposable, DisposableMap, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import type { IOpenAgentsWindowOptions } from '../../../platform/native/common/nativeHost.js';
import type { IChatInputPart } from '../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import type { ChatContextAttachment } from '../../../workbench/services/chat/common/chatContextService.js';
import type { SessionId, IActiveSessionThread, IUntitledChatSession } from '../../services/sessions/common/session.js';
import type { SessionsConversationKind } from '../../services/sessions/common/sessionsConversation.js';

export interface ISessionChatView extends IDisposable {
	readonly element: HTMLElement;
	readonly sessionId: SessionId | undefined;
	readonly input: Pick<IChatInputPart, 'moveDraftTo' | 'replaceDraft'>;
	focus(): void;
	startVoiceConversation(): Promise<void>;
	acquireContext(prepare: (signal: AbortSignal) => Promise<readonly ChatContextAttachment[]>): Promise<readonly ChatContextAttachment[]>;
	addContext(attachment: ChatContextAttachment): void;
	appendToDraft(text: string): void;
	captureDraft(): Promise<{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void; } | undefined>;
	restoreDraft(draft: NonNullable<IOpenAgentsWindowOptions['draft']>): void;
	setVisible(visible: boolean): void;
}

export interface ISessionsConversationPane extends ISessionChatView {
	readonly model: {
		selectThread(active: IActiveSessionThread): Promise<void>;
		selectUntitledSession(session: IUntitledChatSession): void;
	};
}

interface ISessionViewOptions<TSelection, TChat extends ISessionChatView> {
	readonly selection: TSelection;
	readonly kind: SessionsConversationKind;
	readonly createPane: (kind: SessionsConversationKind, container: HTMLElement, panelId: string, selection: TSelection) => TChat;
	readonly bindPane?: (pane: TChat, selection: TSelection) => void;
	readonly shouldRecreatePane?: (previous: TSelection, next: TSelection) => boolean;
	readonly activateSelection?: (selection: TSelection) => void;
	readonly closeSelection?: (selection: TSelection) => void;
}

let nextChatPaneId = 0;

/** One Session's retained chat surface, shared by the Chat and Code compositions. */
export class SessionView<TSelection, TChat extends ISessionChatView> extends Disposable implements IView {
	readonly element: HTMLElement;
	readonly minimumWidth = 300;
	readonly maximumWidth = Number.POSITIVE_INFINITY;
	readonly minimumHeight = 240;
	readonly maximumHeight = Number.POSITIVE_INFINITY;
	private readonly panes = this._register(new DisposableMap<SessionsConversationKind, TChat>());
	private readonly closeAction: HTMLElement;
	private selection: TSelection;
	private kind: SessionsConversationKind;
	private visible = true;

	constructor(container: HTMLElement, private readonly options: ISessionViewOptions<TSelection, TChat>) {
		super();
		this.selection = options.selection;
		this.kind = options.kind;
		this.element = h(container.ownerDocument, 'article');
		this.element.className = 'ash-sessions-chat-slot';
		this._register(toDisposable(() => this.element.remove()));
		try {
			this.attachPane(this.getOrCreatePane(this.kind));
		} catch (error) {
			this.dispose();
			throw error;
		}
		this.closeAction = h(container.ownerDocument, 'div', { className: 'ash-sessions-chat-slot-close' });
		this.closeAction.hidden = true;
		this.element.append(this.closeAction);
		const closeLabel = localize('sessions.closeSession', 'Close Session');
		this._register(new Button(this.closeAction, {
			...defaultButtonStyles,
			presentation: 'quiet',
			icon: Lxicon.close,
			iconOnly: true,
			label: closeLabel,
			title: closeLabel,
			onClick: () => options.closeSelection?.(this.selection),
		}));
		const activate = () => {
			if (!this.element.classList.contains('active')) options.activateSelection?.(this.selection);
		};
		this._register(addDisposableListener(this.element, 'focusin', activate));
		this._register(addDisposableListener(this.element, 'pointerdown', activate));
	}

	get currentSelection(): TSelection { return this.selection; }

	get activeChat(): TChat { return this.panes.get(this.kind)!; }

	openSession(selection: TSelection): void {
		const { shouldRecreatePane } = this.options;
		const previous = this.selection;
		this.selection = selection;
		if (shouldRecreatePane?.(previous, selection)) {
			const focused = this.element.contains(this.element.ownerDocument.activeElement);
			// The host owns the pane's services. Rebind them while retaining the draft identity.
			this.panes.clearAndDisposeAll();
			const pane = this.getOrCreatePane(this.kind);
			this.attachPane(pane);
			if (focused && this.visible) pane.focus();
			return;
		}
		for (const [, pane] of this.panes) this.options.bindPane?.(pane, this.selection);
	}

	setConversationKind(kind: SessionsConversationKind): void {
		if (kind === this.kind || this.isDisposed) return;
		const previous = this.activeChat;
		const next = this.getOrCreatePane(kind);
		const focused = this.element.contains(this.element.ownerDocument.activeElement);
		previous.input.moveDraftTo(next.input);
		previous.setVisible(false);
		previous.element.remove();
		this.kind = kind;
		this.attachPane(next);
		if (focused && this.visible) next.focus();
	}

	setCloseVisible(visible: boolean): void { this.closeAction.hidden = !visible; }

	focus(): void { this.activeChat.focus(); }
	layout(_bounds: Parameters<IView['layout']>[0]): void { }

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.activeChat.setVisible(visible);
	}

	private getOrCreatePane(kind: SessionsConversationKind): TChat {
		let pane = this.panes.get(kind);
		if (!pane) {
			pane = this.options.createPane(kind, this.element, `ash-sessions-conversation-pane-${++nextChatPaneId}`, this.selection);
			pane.element.setAttribute('role', 'region');
			pane.setVisible(false);
			pane.element.remove();
			this.panes.set(kind, pane);
			this.options.bindPane?.(pane, this.selection);
		}
		return pane;
	}

	private attachPane(pane: TChat): void {
		this.element.dataset.conversationKind = this.kind;
		this.element.append(pane.element);
		pane.setVisible(this.visible);
	}

}
