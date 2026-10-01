import "./media/sessionsPart.css";
import { Dimension } from "../../../base/browser/dom.js";
import type { ICommandService } from "../../../platform/commands/common/commands.js";
import type { IAccessibleViewService } from '../../../platform/accessibility/browser/accessibleView.js';
import type { IContextMenuService } from "../../../platform/contextview/browser/contextView.js";
import type { IContextViewService } from "../../../platform/contextview/browser/contextView.js";
import type { IChatService } from "../../../workbench/services/chat/common/chatService.js";
import type { ISessionsManagementService } from "../../services/sessions/common/sessionsManagement.js";
import { WorkbenchPart } from "../../../workbench/browser/part.js";
import type { SessionsViewSelection, SessionsPage } from "../../services/sessions/browser/sessionsService.js";
import { SessionsChatView } from "./sessionsChatView.js";
import type { IChatInputPart } from '../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import type { ChatInputDelegate } from '../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import type { ChatWidgetModel } from '../chatWidgetModel.js';
import { h } from "../../../base/browser/dom.js";
import { localize } from '../../../nls.js';
import type { IDictationService } from '../../../platform/dictation/common/dictationService.js';
import type { INotificationService } from '../../../platform/notification/common/notification.js';
import type { IOpenAgentsWindowOptions } from '../../../platform/native/common/nativeHost.js';

export interface SessionsPartOptions {
	readonly sessionService: ISessionsManagementService;
	readonly chatService: IChatService;
	readonly dictation?: IDictationService;
	readonly contextMenuService: IContextMenuService;
	readonly contextViewService: IContextViewService;
	readonly accessibleViewService: IAccessibleViewService;
	readonly notifications: INotificationService;
	readonly commandService: ICommandService;
	readonly createInputPart: (container: HTMLElement, delegate: ChatInputDelegate, model: ChatWidgetModel, page: SessionsPage) => IChatInputPart;
	readonly activateSelection: (selection: SessionsViewSelection, page: SessionsPage) => void;
	readonly closeSelection: (selection: SessionsViewSelection, page: SessionsPage) => void;
	readonly createNewSession: (page: SessionsPage) => void;
}

/** Passive primary Part that renders the visible Sessions supplied by its owner. */
export class SessionsPart extends WorkbenchPart {
	private readonly views: Record<SessionsPage, SessionsChatView>;
	private page: SessionsPage | "empty" = "chat";
	private readonly header: HTMLDivElement;
	private readonly codePage: HTMLDivElement;
	private readonly heading: HTMLHeadingElement;
	private readonly description: HTMLParagraphElement;

	override get minimumWidth(): number { return 420; }

	constructor(container: HTMLElement, options: SessionsPartOptions) {
		super(container, "sessions");
		const ownerDocument = container.ownerDocument;
		this.header = h(ownerDocument, "div");
		this.header.className = "ash-sessions-surface-header";
		this.heading = h(ownerDocument, "h1");
		this.description = h(ownerDocument, "p");
		this.header.append(this.heading, this.description);
		const createView = (page: SessionsPage, container: HTMLElement): SessionsChatView => this._register(new SessionsChatView(container, {
			chatService: options.chatService,
			dictation: options.dictation,
			sessionService: options.sessionService,
			contextMenuService: options.contextMenuService,
			contextViewService: options.contextViewService,
			accessibleViewService: options.accessibleViewService,
			notifications: options.notifications,
			commandService: options.commandService,
			createInputPart: (container, delegate, model) => options.createInputPart(container, delegate, model, page),
			activateSelection: selection => options.activateSelection(selection, page),
			closeSelection: selection => options.closeSelection(selection, page),
			createNewSession: () => options.createNewSession(page),
		}));
		this.contentDomNode.prepend(this.header);
		this.codePage = h(ownerDocument, 'div');
		this.codePage.className = 'ash-sessions-code-page';
		this.codePage.setAttribute('role', 'region');
		this.codePage.setAttribute('aria-label', localize('sessions.mode.code', 'Code'));
		this.codePage.hidden = true;
		this.views = { chat: createView("chat", this.contentDomNode), code: createView("code", this.codePage) };
		this.contentDomNode.append(this.codePage);
		this.views.code.domNode.hidden = true;
		this.views.code.setVisible(false);
		this.updateVisibleSelections([], undefined);
	}

	focus(): void { this.views[this.page === "code" ? "code" : "chat"].focus(); }

	restoreDraft(draft: NonNullable<IOpenAgentsWindowOptions['draft']>, page: SessionsPage = this.page === 'code' ? 'code' : 'chat'): void { this.views[page].restoreDraft(draft); }

	setPage(page: 'chat' | 'code' | 'empty'): void {
		this.page = page;
		this.contentDomNode.classList.toggle('empty-page', page === 'empty');
		this.header.hidden = page !== 'chat';
		this.views.chat.domNode.hidden = page !== 'chat';
		this.views.code.domNode.hidden = page !== 'code';
		this.views.chat.setVisible(page === 'chat');
		this.views.code.setVisible(page === 'code');
		this.codePage.hidden = page !== 'code';
		if (page !== 'empty') this.layout(new Dimension(this.contentDomNode.clientWidth, this.contentDomNode.clientHeight));
	}

	updateVisibleSelections(selections: readonly SessionsViewSelection[], active: SessionsViewSelection | undefined, page: SessionsPage = "chat"): void {
		if (page === "chat") {
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
		}
		this.views[page].updateVisibleSelections(selections, active);
	}

	override layout(dimension: Dimension): void {
		const view = this.views[this.page === "code" ? "code" : "chat"];
		const bounds = view.domNode.getBoundingClientRect();
		view.layout(new Dimension(bounds.width || dimension.width, bounds.height || dimension.height));
	}
}
