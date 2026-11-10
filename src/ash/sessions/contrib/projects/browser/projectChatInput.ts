import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isWeb } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ChatWidget } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import type { ChatInputDelegate } from '../../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ISessionProviderScopeService } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ReplyChatInputFactory } from '../../chat/browser/replyChatInput.js';
import { ProjectChatModel } from './projectChatModel.js';

/** Retains a Chat draft for the selected project independently of metadata refreshes. */
export class ProjectChatInput extends Disposable {
	public readonly element: HTMLElement;
	private readonly widget: ChatWidget<ProjectChatModel>;

	constructor(
		ownerDocument: Document,
		projectId: string,
		newChat: () => void,
		@ISessionProviderScopeService scopes: ISessionProviderScopeService,
		@ISessionsManagementService sessions: ISessionsManagementService,
		@ICommandService commands: ICommandService,
		@IContextMenuService menus: IContextMenuService,
		@IContextViewService contextViews: IContextViewService,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
		@INotificationService notifications: INotificationService,
		@IOpenerService opener: IOpenerService,
		@IEditorService editors: IEditorService,
	) {
		super();
		const scope = this._register(scopes.createScope(undefined, LOCAL_AGENT_HOST_PROVIDER_ID));
		// Local Chat Projects provide membership while the Chat draft keeps its usual workspace.
		const draft = sessions.createUntitledSession(undefined, { type: 'current' }, LOCAL_AGENT_HOST_PROVIDER_ID, false, undefined, {
			kind: isWeb ? undefined : 'chat',
			projectId,
		});
		this._register(toDisposable(() => sessions.discardUntitledSession(draft.untitledSessionId)));
		const model = scope.createInstance(ProjectChatModel, draft);
		const inputFactory = scope.createInstance(ReplyChatInputFactory);
		const inputLabel = localize('projects.newChat', 'New chat in project');
		this.element = h(ownerDocument, 'section', {
			className: 'ash-projects-composer ash-chat-content-layout',
			attributes: { 'aria-label': inputLabel },
		});
		this._register(addDisposableListener(this.element, 'focusin', event => {
			if (this.element.contains(event.relatedTarget as Node | null)) return;
			const hint = accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.Chat);
			if (hint) status(hint);
		}));
		try {
			this.widget = this._register(scope.createInstance<ChatWidget<ProjectChatModel>>(
				ChatWidget, this.element, `ash-project-chat-${draft.untitledSessionId}`, model, newChat,
				menus, contextViews, commands, accessibleViews, notifications, opener, editors, undefined,
				(container: HTMLElement, delegate: ChatInputDelegate) => inputFactory.create(container, delegate, model, {
					inputLabel,
					explicitModelSelection: true,
					literalServerCommands: true,
					useWorkbenchModelManagement: true,
					persistentDraftScope: 'ash-chat',
				}),
				{ showWelcome: false },
			));
		} catch (error) {
			model.dispose();
			this.dispose();
			throw error;
		}
	}

	get submitted(): boolean {
		return this.widget.model.submitted;
	}
	setVisible(visible: boolean): void {
		this.widget.setVisible(visible);
	}
	focus(): void {
		this.widget.focusInput();
	}
}
