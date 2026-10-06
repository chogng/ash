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
import type { ChatWidgetModel } from '../../chatWidgetModel.js';
import type { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { IOpenAgentsWindowOptions } from '../../../../platform/native/common/nativeHost.js';

export interface SessionsPartOptions {
	readonly sessionService: ISessionsManagementService;
	readonly chatService: IChatService;
	readonly contextMenuService: IContextMenuService;
	readonly contextViewService: IContextViewService;
	readonly accessibleViewService: IAccessibleViewService;
	readonly notifications: INotificationService;
	readonly commandService: ICommandService;
	readonly createInputPart: (container: HTMLElement, delegate: ChatInputDelegate, model: ChatWidgetModel) => IChatInputPart;
	readonly activateSelection: (selection: SessionsViewSelection) => void;
	readonly closeSelection: (selection: SessionsViewSelection) => void;
	readonly createNewSession: () => void;
}

/** Passive primary Part that renders the visible Sessions supplied by its owner. */
export class SessionsPart extends WorkbenchPart {
	private readonly view: SessionsChatView;

	override get minimumWidth(): number { return 420; }

	constructor(container: HTMLElement, options: SessionsPartOptions, @IInstantiationService services: IInstantiationService) {
		super(container, "sessions");
		this.view = this._register(services.createInstance(SessionsChatView, this.contentDomNode, {
			chatService: options.chatService,
			sessionService: options.sessionService,
			contextMenuService: options.contextMenuService,
			contextViewService: options.contextViewService,
			accessibleViewService: options.accessibleViewService,
			notifications: options.notifications,
			commandService: options.commandService,
			createInputPart: options.createInputPart,
			activateSelection: options.activateSelection,
			closeSelection: options.closeSelection,
			createNewSession: options.createNewSession,
		} satisfies SessionsChatViewOptions));
		this.updateVisibleSelections([], undefined);
	}

	focus(): void { this.view.focus(); }

	addContext(attachment: ChatContextAttachment): void { this.view.addContext(attachment); }

	appendToDraft(text: string): void { this.view.appendToDraft(text); }

	captureActiveDraft(): Promise<{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void } | undefined> { return this.view.captureActiveDraft(); }

	restoreDraft(draft: NonNullable<IOpenAgentsWindowOptions['draft']>): void { this.view.restoreDraft(draft); }

	updateVisibleSelections(selections: readonly SessionsViewSelection[], active: SessionsViewSelection | undefined): void {
		this.view.updateVisibleSelections(selections, active);
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.view.setVisible(visible);
	}

	override layout(dimension: Dimension): void {
		const bounds = this.view.domNode.getBoundingClientRect();
		this.view.layout(new Dimension(bounds.width || dimension.width, bounds.height || dimension.height));
	}
}
