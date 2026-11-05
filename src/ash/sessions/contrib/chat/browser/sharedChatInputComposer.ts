import { IGitHubService } from '../../github/browser/githubService.js';
import { attachSessionGitHubReference } from './sessionChatInputToolbar.js';
import { AGENT_SESSIONS_SCOPED_INPUT_HISTORY_SETTING } from './sessionsChatHistory.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import * as chatInputStatePersistence from '../../../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { autorun, type IObservable } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { ChatWidgetModel } from '../../../browser/chatWidgetModel.js';
import type { ChatInputDelegate } from '../../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { ChatInputPart, type ChatInputPartOptions } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import type { IChatInputEditorProvider } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputEditorRegistry.js';
import { ChatInputEditor } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputEditor.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { SESSIONS_COMPACT_INPUT_HEIGHT } from '../common/constants.js';
import { approvalModeDefinition, approvalModeDefinitions } from '../../../../platform/agentHost/common/approvalModes.js';
import { IApprovalEnvironmentService } from '../../../../platform/approvalEnvironment/common/approvalEnvironmentService.js';
import { OPEN_GUARDIAN_SETUP_COMMAND_ID } from '../../../../workbench/contrib/chat/common/chat.js';
import { getSessionsChatAccessibilityHelp } from './sessionsChatAccessibilityHelp.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { readNewChatDraftState, writeNewChatDraftState } from '../common/newChatDraftState.js';
import { status as announceStatus } from '../../../../base/browser/ui/aria/aria.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';

/** Composes Sessions policy around the input owned by the Chat widget. */
export class SharedChatInputComposer extends Disposable {
	readonly input: ChatInputPart;
	readonly saveState: () => Promise<void>;

	constructor(
		container: HTMLElement,
		delegate: ChatInputDelegate,
		model: ChatWidgetModel,
		chatPresentation: IObservable<boolean>,
		@IContextMenuService contextMenus: IContextMenuService,
		@IContextViewService contextViews: IContextViewService,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
		@INotificationService notifications: INotificationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IStorageService storage: IStorageService,
		@ILifecycleService lifecycle: ILifecycleService,
		@IQuickInputService quickInput: IQuickInputService,
		@IConfigurationService configuration: IConfigurationService,
		@ICommandService commands: ICommandService,
		@IGitHubService github: IGitHubService,
		@IApprovalEnvironmentService approvalEnvironment: IApprovalEnvironmentService | undefined,
	) {
		super();
		const permissionPicker: ChatInputPartOptions['primaryPermissionPicker'] = {
			action: {
				id: 'sessions.chat.permissions',
				get label() {
					const definition = approvalModeDefinition(model.inputState.approvalMode);
					return localize(definition.label.key, definition.label.text);
				},
				get tooltip() { return localize('sessions.chat.permission.label', 'Permissions: {0}', this.label); },
				get enabled() { return !model.inputState.aiDisabled && model.inputState.phase !== 'submitting'; },
				run: () => this.input.openPermissionPicker(),
			},
			onDidChange: model.onDidChange,
			actionProvider: {
				getActions: () => [
					...approvalModeDefinitions.map(definition => ({
						id: definition.id,
						label: localize(definition.label.key, definition.label.text),
						tooltip: localize(definition.description.key, definition.description.text),
						enabled: true,
						checked: definition.id === model.inputState.approvalMode,
						run: () => commands.executeCommand(`sessions.chat.permission.${definition.id}`, model),
					})),
					...(approvalEnvironment ? [{
						id: OPEN_GUARDIAN_SETUP_COMMAND_ID,
						label: localize('approvalEnvironment.title', 'Prepare review environment…'),
						tooltip: '',
						enabled: true,
						run: () => commands.executeCommand(OPEN_GUARDIAN_SETUP_COMMAND_ID, model),
					}] : []),
				],
			},
		};
		const input = this.input = instantiationService.createInstance(ChatInputPart, container, delegate, contextMenus, contextViews, accessibleViews, notifications, {
			create: options => instantiationService.createInstance(ChatInputEditor, {
				...options,
				placeholder: localize('sessions.chat.inputPlaceholder', 'Describe a task or ask a question'),
				tabFocusMode: true,
				// Let the row center the actual text height beside its 28px controls.
				height: options.height ?? SESSIONS_COMPACT_INPUT_HEIGHT,
			}),
		} satisfies Pick<IChatInputEditorProvider, 'create'>, [], {
			layout: 'compact', modelPickerPosition: 'trailing', configureModelInMenu: true, renderSecondaryToolbar: false, draftStorage: 'host',
			contextUsageInFooter: true,
			get modePicker() { return chatPresentation.get() ? 'hidden' : 'visible'; },
			get chatModelSlider() { return chatPresentation.get(); },
			get showContextUsage() { return !chatPresentation.get(); },
			accessibilityHelp: getSessionsChatAccessibilityHelp,
			statusText: (state, contexts, status) => {
				// The host exposes catalog loading through aria-busy. Keep actionable draft status visible.
				if (!state.aiDisabled && model.untitledSessionId !== undefined && state.phase === 'loading' && !state.error && state.status === undefined) {
					return '';
				}
				if (!status && state.phase === 'ready' && !state.inputBlocked && model.threadId
					&& contexts.some(context => context.kind === 'transcriptContext' && context.id === 'initial-pr:' + model.threadId)) {
					return localize({ bundle: 'ash.sessions', key: 'sessions.github.pullRequestDraftReady' }, 'The pull request worktree is ready. Its snapshot is attached to your first message.');
				}
				return status;
			},
			attachGitHubReference: (kind, signal) => attachSessionGitHubReference(kind, model, github, quickInput, signal),
			get primaryPermissionPicker() { return chatPresentation.get() ? undefined : permissionPicker; },
		} satisfies ChatInputPartOptions);
		this._register(autorun(reader => {
			chatPresentation.read(reader);
			input.refreshPresentation();
		}));
		const form = input.composerForm;
		this._register(addDisposableListener(form, 'focusin', event => {
			if (form.contains(event.relatedTarget as Node | null)) return;
			const hint = accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.Chat);
			if (hint) announceStatus(hint);
		}));
		const updateHistoryScope = () => input.setHistoryScope(configuration.getValue<boolean>(AGENT_SESSIONS_SCOPED_INPUT_HISTORY_SETTING) === false
			? undefined : JSON.stringify(model.sessionId ? ['sessions', model.sessionId] : ['sessions-draft', model.untitledSessionId]));
		updateHistoryScope();
		this._register(model.onDidChange(updateHistoryScope));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AGENT_SESSIONS_SCOPED_INPUT_HISTORY_SETTING)) updateHistoryScope();
		}));
		this.saveState = input.bindDraftStorage(model, {
			read: identity => readNewChatDraftState(storage, identity, chatInputStatePersistence),
			write: (identity, draft) => writeNewChatDraftState(storage, draft, identity, chatInputStatePersistence),
			flush: () => storage.flush(),
		}, lifecycle.onWillShutdown);
	}
}
