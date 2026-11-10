import type { IAction } from '../../../../base/common/actions.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import type { IChatWidgetModel } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import type { ChatInputDelegate } from '../../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { ChatInputEditor } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputEditor.js';
import type { ChatInputEditorOptions } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputEditorRegistry.js';
import { ChatInputPart, type ChatInputPartOptions } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import * as chatInputStatePersistence from '../../../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { SESSIONS_COMPACT_INPUT_HEIGHT } from '../common/constants.js';
import { readNewChatDraftState, writeNewChatDraftState } from '../common/newChatDraftState.js';
import './media/chatInput.css';
import './media/chatInputCard.css';

export interface ReplyChatDraftPicker extends IDisposable {
	getAttachMenuProjectActions?(): readonly IAction[] | undefined;
}

interface ReplyChatInputOptions {
	readonly inputLabel?: string;
	readonly explicitModelSelection?: true;
	readonly literalServerCommands?: true;
	readonly useWorkbenchModelManagement?: true;
	readonly persistentDraftScope?: string;
	readonly createDraftPicker?: (footer: HTMLElement) => ReplyChatDraftPicker;
	readonly accessibilityHelp?: () => string;
}

export class ReplyChatInputFactory {
	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextMenuService private readonly menus: IContextMenuService,
		@IContextViewService private readonly contextViews: IContextViewService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
		@INotificationService private readonly notifications: INotificationService,
		@IStorageService private readonly storage: IStorageService,
		@ILifecycleService private readonly lifecycle: ILifecycleService,
	) { }

	create(container: HTMLElement, delegate: ChatInputDelegate, model: IChatWidgetModel, options: ReplyChatInputOptions): ChatInputPart {
		let draftPicker: ReplyChatDraftPicker | undefined;
		const createDraftPicker = options.createDraftPicker;
		const input = this.instantiation.createInstance(ChatInputPart, container, {
			...delegate,
			selectAutomaticModel: options.explicitModelSelection ? undefined : delegate.selectAutomaticModel,
			executeServerCommand: options.literalServerCommands ? undefined : delegate.executeServerCommand,
		}, this.menus, this.contextViews, this.accessibleViews, this.notifications, {
			create: (editorOptions: ChatInputEditorOptions) => this.instantiation.createInstance(ChatInputEditor, {
				...editorOptions,
				placeholder: localize('sessions.chat.inputPlaceholder', 'Describe a task or ask a question'),
				height: SESSIONS_COMPACT_INPUT_HEIGHT,
				tabFocusMode: true,
			}),
		}, [], {
			layout: 'compact',
			stageImages: !delegate.draft,
			modePicker: 'hidden',
			modelPickerPosition: 'trailing',
			useWorkbenchModelManagement: options.useWorkbenchModelManagement === true,
			configureModelInMenu: true,
			chatModelSlider: true,
			renderSecondaryToolbar: false,
			draftStorage: 'host',
			renderLeadingFooter: createDraftPicker && (footer => draftPicker = createDraftPicker(footer)),
			attachMenuHost: { getProjectActions: () => draftPicker?.getAttachMenuProjectActions?.() },
			inputLabel: options.inputLabel,
			accessibilityHelp: options.accessibilityHelp,
		} satisfies ChatInputPartOptions);
		const draftScope = options.persistentDraftScope;
		if (draftScope) {
			input.bindDraftStorage(model, {
				read: identity => readNewChatDraftState(this.storage, `${draftScope}:${identity}`, chatInputStatePersistence),
				write: (identity, draft) => writeNewChatDraftState(this.storage, draft, `${draftScope}:${identity}`, chatInputStatePersistence),
				flush: () => this.storage.flush(),
			}, this.lifecycle.onWillShutdown);
		}
		input.composerForm.classList.add('ash-sessions-chat-input-card', 'floating-card');
		input.element.classList.add('ash-sessions-chat-input');
		return input;
	}
}
