import "./media/sessionsPart.css";
import { Dimension } from "../../../base/browser/dom.js";
import type { ICommandService } from "../../../platform/commands/common/commands.js";
import type { IContextMenuService } from "../../../platform/contextview/browser/contextView.js";
import type { IContextViewService } from "../../../platform/contextview/browser/contextView.js";
import type { IChatService } from "../../../workbench/services/chat/common/chatService.js";
import type { ISessionsManagementService } from "../../services/sessions/common/sessionsManagement.js";
import { WorkbenchPart } from "../../../workbench/browser/part.js";
import type { SessionsViewSelection } from "../../services/sessions/browser/sessionsService.js";
import { SessionsChatView } from "./sessionsChatView.js";
import { h } from "../../../base/browser/dom.js";
import { localize } from '../../../nls.js';

export interface SessionsPartOptions {
	readonly sessionService: ISessionsManagementService;
	readonly chatService: IChatService;
	readonly contextMenuService: IContextMenuService;
	readonly contextViewService: IContextViewService;
	readonly commandService: ICommandService;
	readonly activateSelection: (selection: SessionsViewSelection) => void;
	readonly closeSelection: (selection: SessionsViewSelection) => void;
}

/** Passive primary Part that renders the visible Sessions supplied by its owner. */
export class SessionsPart extends WorkbenchPart {
	private readonly chat: SessionsChatView;
	private readonly heading: HTMLHeadingElement;
	private readonly description: HTMLParagraphElement;

	override get minimumWidth(): number { return 420; }

	constructor(container: HTMLElement, options: SessionsPartOptions) {
		super(container, "sessions");
		const ownerDocument = container.ownerDocument;
		const header = h(ownerDocument, "div");
		header.className = "ash-sessions-surface-header";
		this.heading = h(ownerDocument, "h1");
		this.description = h(ownerDocument, "p");
		header.append(this.heading, this.description);
		this.chat = this._register(new SessionsChatView(this.contentDomNode, {
			chatService: options.chatService,
			sessionService: options.sessionService,
			contextMenuService: options.contextMenuService,
			contextViewService: options.contextViewService,
			commandService: options.commandService,
			activateSelection: options.activateSelection,
			closeSelection: options.closeSelection,
		}));
		this.contentDomNode.prepend(header);
		this.updateVisibleSelections([], undefined);
	}

	focus(): void { this.chat.focus(); }

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
