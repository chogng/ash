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
import { SessionsChatView, type SessionsChatViewOptions } from "./sessionsChatView.js";
import { SessionsPageRegistry, type ISessionsPageView } from '../pages.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import type { IChatInputPart } from '../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import type { ChatInputDelegate } from '../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import type { ChatWidgetModel } from '../chatWidgetModel.js';
import { h } from "../../../base/browser/dom.js";
import { localize } from '../../../nls.js';
import type { INotificationService } from '../../../platform/notification/common/notification.js';
import type { IOpenAgentsWindowOptions } from '../../../platform/native/common/nativeHost.js';

export interface SessionsPartOptions {
	readonly sessionService: ISessionsManagementService;
	readonly chatService: IChatService;
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
	private page: SessionsPage | 'design' | 'empty' = 'chat';
	private readonly codePage: HTMLDivElement;
	private readonly contributedPages = new Map<string, { readonly container: HTMLElement; readonly view: ISessionsPageView }>();

	override get minimumWidth(): number { return 420; }

	constructor(container: HTMLElement, options: SessionsPartOptions, @IInstantiationService services: IInstantiationService) {
		super(container, "sessions");
		const ownerDocument = container.ownerDocument;
		const createView = (page: SessionsPage, container: HTMLElement): SessionsChatView => this._register(services.createInstance(SessionsChatView, container, {
			page,
			chatService: options.chatService,
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
		} satisfies SessionsChatViewOptions));
		this.codePage = h(ownerDocument, 'div');
		this.codePage.className = 'ash-sessions-code-page';
		this.codePage.setAttribute('role', 'region');
		this.codePage.setAttribute('aria-label', localize('sessions.mode.code', 'Code'));
		this.codePage.hidden = true;
		this.views = { chat: createView("chat", this.contentDomNode), code: createView("code", this.codePage) };
		this.contentDomNode.append(this.codePage);
		for (const [id, descriptor] of SessionsPageRegistry.getPages()) {
			const container = h(ownerDocument, 'div', { className: 'ash-sessions-contributed-page' });
			container.dataset.sessionsPage = id;
			container.hidden = true;
			const view = this._register(services.createInstance(descriptor, ownerDocument));
			container.append(view.domNode);
			this.contentDomNode.append(container);
			this.contributedPages.set(id, { container, view });
		}
		this.views.code.domNode.hidden = true;
		this.views.code.setVisible(false);
		this.updateVisibleSelections([], undefined);
	}

	focus(): void {
		const contributedPage = this.contributedPages.get(this.page);
		if (contributedPage) {
			contributedPage.view.focus();
			return;
		}
		this.views[this.page === "code" ? "code" : "chat"].focus();
	}

	appendToDraft(text: string, page: SessionsPage): void { this.views[page].appendToDraft(text); }

	captureActiveDraft(page: SessionsPage): Promise<{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void } | undefined> { return this.views[page].captureActiveDraft(); }

	restoreDraft(draft: NonNullable<IOpenAgentsWindowOptions['draft']>, page: SessionsPage = this.page === 'code' ? 'code' : 'chat'): void { this.views[page].restoreDraft(draft); }

	setPage(page: 'chat' | 'code' | 'design' | 'empty'): void {
		this.page = page;
		this.contentDomNode.classList.toggle('empty-page', page === 'empty');
		this.views.chat.domNode.hidden = page !== 'chat';
		this.views.code.domNode.hidden = page !== 'code';
		this.views.chat.setVisible(page === 'chat');
		this.views.code.setVisible(page === 'code');
		this.codePage.hidden = page !== 'code';
		for (const [id, contributedPage] of this.contributedPages) {
			contributedPage.container.hidden = page !== id;
		}
	}

	updateVisibleSelections(selections: readonly SessionsViewSelection[], active: SessionsViewSelection | undefined, page: SessionsPage = "chat"): void {
		this.views[page].updateVisibleSelections(selections, active);
	}

	override layout(dimension: Dimension): void {
		// Empty pages resize the Part, not the retained Chat or Code geometry beneath it.
		if (this.page === 'empty') {
			return;
		}
		const contributedPage = this.contributedPages.get(this.page);
		if (contributedPage) {
			const bounds = contributedPage.container.getBoundingClientRect();
			contributedPage.view.layout(new Dimension(bounds.width, bounds.height));
			return;
		}
		const view = this.views[this.page === "code" ? "code" : "chat"];
		const bounds = view.domNode.getBoundingClientRect();
		view.layout(new Dimension(bounds.width || dimension.width, bounds.height || dimension.height));
	}
}
