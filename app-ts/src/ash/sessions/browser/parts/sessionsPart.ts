import "./media/sessionsPart.css";
import { Dimension } from "../../../base/browser/dom.js";
import type { ICommandService } from "../../../platform/commands/common/commands.js";
import type { IAccessibleViewService } from '../../../platform/accessibility/browser/accessibleView.js';
import type { IContextMenuService } from "../../../platform/contextview/browser/contextView.js";
import type { IContextViewService } from "../../../platform/contextview/browser/contextView.js";
import type { IChatService } from "../../../workbench/services/chat/common/chatService.js";
import type { ISessionsManagementService } from "../../services/sessions/common/sessionsManagement.js";
import { WorkbenchPart } from "../../../workbench/browser/part.js";
import type { SessionsViewSelection } from "../../services/sessions/browser/sessionsService.js";
import { SessionsChatView } from "./sessionsChatView.js";
import { observableValue, type IObservable } from '../../../base/common/observable.js';
import type { ChatInputPart } from '../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import type { ChatInputDelegate } from '../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import type { ChatWidgetModel } from '../chatWidgetModel.js';
import { h } from "../../../base/browser/dom.js";
import { localize } from '../../../nls.js';
import type { IDictationService } from '../../../platform/dictation/common/dictationService.js';
import type { INotificationService } from '../../../platform/notification/common/notification.js';
import type { IOpenAgentsWindowOptions } from '../../../platform/native/common/nativeHost.js';

export type SessionsComposerPresentation = 'chat' | 'code';

export interface SessionsPartOptions {
	readonly sessionService: ISessionsManagementService;
	readonly chatService: IChatService;
	readonly dictation?: IDictationService;
	readonly contextMenuService: IContextMenuService;
	readonly contextViewService: IContextViewService;
	readonly accessibleViewService: IAccessibleViewService;
	readonly notifications: INotificationService;
	readonly commandService: ICommandService;
	readonly createInputPart: (container: HTMLElement, delegate: ChatInputDelegate, model: ChatWidgetModel, presentation: IObservable<SessionsComposerPresentation>) => ChatInputPart;
	readonly activateSelection: (selection: SessionsViewSelection) => void;
	readonly closeSelection: (selection: SessionsViewSelection) => void;
}

/** Passive primary Part that renders the visible Sessions supplied by its owner. */
export class SessionsPart extends WorkbenchPart {
	private readonly chat: SessionsChatView;
	private readonly header: HTMLDivElement;
	private readonly codePage: HTMLDivElement;
	private readonly heading: HTMLHeadingElement;
	private readonly description: HTMLParagraphElement;
	private readonly inputPresentation = observableValue<SessionsComposerPresentation>(this, 'chat');

	override get minimumWidth(): number { return 420; }

	constructor(container: HTMLElement, options: SessionsPartOptions) {
		super(container, "sessions");
		const ownerDocument = container.ownerDocument;
		this.header = h(ownerDocument, "div");
		this.header.className = "ash-sessions-surface-header";
		this.heading = h(ownerDocument, "h1");
		this.description = h(ownerDocument, "p");
		this.header.append(this.heading, this.description);
		this.chat = this._register(new SessionsChatView(this.contentDomNode, {
			chatService: options.chatService,
			dictation: options.dictation,
			sessionService: options.sessionService,
			contextMenuService: options.contextMenuService,
			contextViewService: options.contextViewService,
			accessibleViewService: options.accessibleViewService,
			notifications: options.notifications,
			commandService: options.commandService,
			createInputPart: (container, delegate, model) => options.createInputPart(container, delegate, model, this.inputPresentation),
			activateSelection: options.activateSelection,
			closeSelection: options.closeSelection,
		}));
		// Page navigation retains the conversation owner; it must not create a second draft or Thread subscription.
		this.contentDomNode.prepend(this.header);
		this.codePage = h(ownerDocument, 'div');
		this.codePage.className = 'ash-sessions-code-page';
		this.codePage.setAttribute('role', 'region');
		this.codePage.setAttribute('aria-label', localize('sessions.mode.code', 'Code'));
		this.codePage.hidden = true;
		this.contentDomNode.append(this.codePage);
		this.updateVisibleSelections([], undefined);
	}

	focus(): void { this.chat.focus(); }

	restoreDraft(draft: NonNullable<IOpenAgentsWindowOptions['draft']>): void { this.chat.restoreDraft(draft); }

	setPage(page: 'chat' | 'code' | 'empty'): void {
		this.contentDomNode.classList.toggle('empty-page', page === 'empty');
		this.header.hidden = page !== 'chat';
		this.chat.domNode.hidden = page === 'empty';
		this.codePage.hidden = page !== 'code';
		if (page !== 'empty') {
			// The input owns its named appearance. Hosts only select it and position the retained view root.
			this.inputPresentation.set(page);
			(page === 'code' ? this.codePage : this.contentDomNode).append(this.chat.domNode);
			this.layout(new Dimension(this.contentDomNode.clientWidth, this.contentDomNode.clientHeight));
		}
	}

	updateVisibleSelections(selections: readonly SessionsViewSelection[], active: SessionsViewSelection | undefined): void {
		if (active?.kind === "session") {
			this.heading.textContent = active.active.session.title.trim() || "Agent session";
			this.description.textContent = localize('sessions.header.chatCount', '{0} chats', active.active.session.chats.length);
		} else if (active?.kind === "untitled") {
			this.heading.textContent = active.session.title.trim() || "New code session";
			this.description.textContent = localize('sessions.header.draft', 'Draft session');
		} else {
			this.heading.textContent = "Agent sessions";
			this.description.textContent = "Plan, implement, and review work in a focused agent workspace.";
		}
		this.chat.updateVisibleSelections(selections, active);
	}

	override layout(dimension: Dimension): void {
		const bounds = this.chat.domNode.getBoundingClientRect();
		this.chat.layout(new Dimension(bounds.width || dimension.width, bounds.height || dimension.height));
	}
}
