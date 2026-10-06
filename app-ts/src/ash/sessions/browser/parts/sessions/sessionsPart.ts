import type { ChatContextAttachment } from '../../../../workbench/services/chat/common/chatContextService.js';
import "./media/sessionsPart.css";
import { Dimension } from "../../../../base/browser/dom.js";
import type { ICommandService } from "../../../../platform/commands/common/commands.js";
import type { IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import type { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import type { IContextViewService } from "../../../../platform/contextview/browser/contextView.js";
import type { IChatService } from "../../../../workbench/services/chat/common/chatService.js";
import type { ISessionsManagementService } from "../../../services/sessions/common/sessionsManagement.js";
import { WorkbenchPart } from "../../../../workbench/browser/part.js";
import type { SessionsViewSelection } from "../../../services/sessions/browser/sessionsService.js";
import { SessionsChatView, type SessionsChatViewOptions } from "./sessionsChatView.js";
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { IChatInputPart } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import type { ChatInputDelegate } from '../../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { ChatWidgetModel } from '../../chatWidgetModel.js';
import { ChatWidget } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import type { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { IOpenAgentsWindowOptions } from '../../../../platform/native/common/nativeHost.js';
import type { ISessionsConversationService, SessionsConversationKind } from '../../../services/sessions/common/sessionsConversation.js';

export interface SessionsPartOptions {
	readonly sessionService: ISessionsManagementService;
	readonly chatService: IChatService;
	readonly contextMenuService: IContextMenuService;
	readonly contextViewService: IContextViewService;
	readonly accessibleViewService: IAccessibleViewService;
	readonly notifications: INotificationService;
	readonly commandService: ICommandService;
	readonly createInputPart: (container: HTMLElement, delegate: ChatInputDelegate, model: ChatWidgetModel) => IChatInputPart;
	readonly createCoworkPane: NonNullable<SessionsChatViewOptions['createPane']>;
	readonly activateSelection: (selection: SessionsViewSelection) => void;
	readonly closeSelection: (selection: SessionsViewSelection) => void;
	readonly createNewSession: () => void;
}

/** Passive primary Part that renders the visible Sessions supplied by its owner. */
export class SessionsPart extends WorkbenchPart implements ISessionsConversationService {
	private view: SessionsChatView;
	private readonly views = new Map<SessionsConversationKind, SessionsChatView>();
	private kind: SessionsConversationKind = 'code';
	private selections: readonly SessionsViewSelection[] = [];
	private activeSelection: SessionsViewSelection | undefined;
	private visible = true;
	private lastDimension: Dimension | undefined;

	override get minimumWidth(): number { return 420; }

	constructor(container: HTMLElement, private readonly options: SessionsPartOptions, @IInstantiationService private readonly services: IInstantiationService) {
		super(container, "sessions");
		this.view = this.createView('code');
		this.view.setVisible(true);
		this.updateVisibleSelections([], undefined);
	}

	private createView(kind: SessionsConversationKind): SessionsChatView {
		const options = this.options;
		const view = this._register(this.services.createInstance(SessionsChatView, this.contentDomNode, {
			sessionService: options.sessionService,
			createPane: kind === 'cowork' ? options.createCoworkPane : (container, panelId, selection) => {
				const model = this.services.createInstance(ChatWidgetModel, options.chatService, selection.kind === 'session' ? { kind: 'session', active: selection.active } : { kind: 'untitled', session: selection.session }, options.sessionService);
				return this.services.createInstance<ChatWidget<ChatWidgetModel>>(ChatWidget, container, panelId, model, options.createNewSession, options.contextMenuService, options.contextViewService, options.commandService, options.accessibleViewService, options.notifications, undefined, undefined, undefined,
					(inputContainer: HTMLElement, delegate: ChatInputDelegate) => options.createInputPart(inputContainer, delegate, model));
			},
			activateSelection: options.activateSelection,
			closeSelection: options.closeSelection,
		} satisfies SessionsChatViewOptions));
		view.domNode.dataset.conversationKind = kind;
		view.setVisible(false);
		this.views.set(kind, view);
		return view;
	}

	public async setConversationKind(kind: SessionsConversationKind): Promise<void> {
		if (kind === this.kind) { return; }
		const drafts = await this.view.captureDrafts();
		let next = this.views.get(kind);
		if (!next) { next = this.createView(kind); }
		next.updateVisibleSelections(this.selections, this.activeSelection);
		await next.restoreDrafts(drafts);
		this.view.setVisible(false);
		this.view.domNode.remove();
		this.view = next;
		this.kind = kind;
		this.contentDomNode.append(this.view.domNode);
		this.view.setVisible(this.visible);
		if (this.lastDimension) { this.layout(this.lastDimension); }
	}

	focus(): void { this.view.focus(); }

	addContext(attachment: ChatContextAttachment): void { this.view.addContext(attachment); }

	appendToDraft(text: string): void { this.view.appendToDraft(text); }

	captureActiveDraft(): Promise<{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void; } | undefined> { return this.view.captureActiveDraft(); }

	restoreDraft(draft: NonNullable<IOpenAgentsWindowOptions['draft']>): void { this.view.restoreDraft(draft); }

	updateVisibleSelections(selections: readonly SessionsViewSelection[], active: SessionsViewSelection | undefined): void {
		this.selections = selections;
		this.activeSelection = active;
		for (const view of this.views.values()) { view.updateVisibleSelections(selections, active); }
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.visible = visible;
		this.view.setVisible(visible);
	}

	override layout(dimension: Dimension): void {
		this.lastDimension = dimension;
		const bounds = this.view.domNode.getBoundingClientRect();
		this.view.layout(new Dimension(bounds.width || dimension.width, bounds.height || dimension.height));
	}
}
