import { Event } from '../../../../base/common/event.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { ActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Action, type IAction } from '../../../../base/common/actions.js';
import { equals } from '../../../../base/common/arrays.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ChatInputEditor } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputEditor.js';
import { ChatInputAction, ChatInputSurface } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputSurface.js';
import { DictationInput } from '../../../../workbench/contrib/chat/browser/speechToText/dictationInputController.js';
import { notifyDictationSubmitted } from '../../../../workbench/contrib/chat/browser/speechToText/dictationSession.js';
import { IDictationOnboardingService } from '../../../../workbench/contrib/chat/browser/speechToText/dictationOnboarding.js';
import { SkillSelectorCatalog } from '../../../../workbench/contrib/chat/common/skillSelectors.js';
import { SlashCommandCatalog } from '../../../../workbench/contrib/chat/common/slashCommands.js';
import { IChatSpeechToTextService } from '../../../../workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { IPreferencesService } from '../../../../workbench/services/preferences/common/preferences.js';
import { canQueueChatGPTCreation, IChatGPTService, isCoworkSubmission, selectedChatConversationId, type ChatGPTAttachment, type ChatGPTState } from './chatGPTService.js';
import { ModelPickerWidget } from './modelPickerWidget.js';
import { ISessionProviderScopeService } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { NEW_CHAT_WITH_MODEL_COMMAND, SESSIONS_COMPACT_INPUT_HEIGHT } from '../../chat/common/constants.js';
import '../../../common/theme.js';
import '../../../../base/browser/ui/button/button.css';
import './media/chatGPTInputWidget.css';
import '../../chat/browser/media/chatInputCard.css';

const noChatGPTModels: ChatGPTState['models'] = [];

/** Adapts ChatGPT drafts and actions to the shared chat input surface. */
export class ChatGPTInputWidget extends Disposable {
	private readonly element: HTMLFormElement;
	private readonly editor: ChatInputEditor;
	private readonly surface: ChatInputSurface<ChatInputEditor>;
	private readonly modelAction = this._register(new Action('ash.chatgpt.input.model'));
	private modelPicker: ModelPickerWidget | undefined;
	private actions: readonly ChatInputAction[] = [];
	private readonly dictation: DictationInput;
	private readonly dictationHost = this._register(new MutableDisposable());
	private readonly filePicker: HTMLInputElement;
	private readonly attachmentList: HTMLElement;
	private readonly attachmentRows = new Map<string, { element: HTMLElement; name: HTMLElement; status: HTMLElement; error: HTMLElement; retry: HTMLButtonElement; remove: HTMLButtonElement; }>();
	private readonly voiceStatus: HTMLElement;
	private readonly voiceTranscript: HTMLElement;
	private visible = true;
	private inputIdentity: string | undefined;
	private inputGeneration = 0;

	constructor(
		private readonly container: HTMLElement,
		@IChatGPTService private readonly chat: IChatGPTService,
		@IInstantiationService instantiation: IInstantiationService,
		@IContextMenuService contextMenus: IContextMenuService,
		@IChatSpeechToTextService speech: IChatSpeechToTextService,
		@IDictationOnboardingService private readonly onboarding: IDictationOnboardingService,
		@IPreferencesService preferences: IPreferencesService,
		@INotificationService private readonly notifications: INotificationService,
		@ICommandService private readonly commands: ICommandService,
		@ISessionProviderScopeService private readonly scopes: ISessionProviderScopeService,
	) {
		super();
		const prompt = localize('sessions.chatgpt.prompt', 'Ask ChatGPT');
		this.surface = this._register(new ChatInputSurface(container, contextMenus, {
			createEditor: input => {
				input.classList.add('ash-chatgpt-input');
				return instantiation.createInstance(ChatInputEditor, {
					container: input,
					placeholder: localize('sessions.chat.inputPlaceholder', 'Describe a task or ask a question'),
					ariaLabel: prompt,
					// ChatGPT sends plain prompts and has no Agent commands or skill selectors.
					slashCommands: new SlashCommandCatalog([], []),
					skills: new SkillSelectorCatalog(),
					height: SESSIONS_COMPACT_INPUT_HEIGHT,
					tabFocusMode: true,
				});
			},
			submit: () => { void this.submit(); },
			modelPickerPosition: 'trailing',
			layout: 'compact',
			actionViewItemProvider: action => action === this.modelAction ? new ChatGPTModelPickerActionItem(action, host => {
				this.modelPicker = instantiation.createInstance(ModelPickerWidget, host, (model: string) => this.chat.setModel(model));
				return this.modelPicker;
			}) : undefined,
		}));
		this.editor = this.surface.editor;
		this.element = this.surface.form;
		this.element.classList.add('ash-chatgpt-composer', 'ash-sessions-chat-input-card', 'floating-card');
		const toolbarFooter = this.surface.footer!;
		toolbarFooter.classList.add('ash-sessions-chat-input-footer');
		container.append(toolbarFooter);
		this.surface.toolbar.setActions([this.modelAction]);
		this.attachmentList = h(container.ownerDocument, 'div');
		this.attachmentList.className = 'ash-chatgpt-input-attachments';
		this.attachmentList.setAttribute('role', 'list');
		this.attachmentList.setAttribute('aria-label', localize('sessions.chatgpt.attachments', 'Attachments'));
		this.attachmentList.setAttribute('aria-live', 'polite');
		this.voiceStatus = h(container.ownerDocument, 'p');
		this.voiceStatus.className = 'ash-chatgpt-voice-status';
		this.voiceStatus.setAttribute('role', 'status');
		this.voiceTranscript = h(container.ownerDocument, 'p');
		this.voiceTranscript.className = 'ash-chatgpt-voice-transcript';
		container.insertBefore(this.attachmentList, this.element);
		container.insertBefore(this.voiceStatus, this.element);
		container.insertBefore(this.voiceTranscript, this.element);
		this.filePicker = h(container.ownerDocument, 'input');
		this.filePicker.type = 'file';
		this.filePicker.multiple = true;
		this.filePicker.hidden = true;
		this.element.append(this.filePicker);
		this._register(addDisposableListener(this.filePicker, 'change', () => {
			const files = [...this.filePicker.files ?? []];
			this.filePicker.value = '';
			if (!this.controlsDisabled(this.chat.state.get())) void this.chat.attachFiles(files);
		}));
		this._register(addDisposableListener(this.element, 'paste', event => {
			if (this.controlsDisabled(this.chat.state.get()) || !event.clipboardData?.files.length) { return; }
			event.preventDefault();
			void this.chat.attachFiles([...event.clipboardData.files]);
		}));
		this._register(addDisposableListener(this.element, 'dragover', event => {
			if (!this.controlsDisabled(this.chat.state.get()) && [...event.dataTransfer?.items ?? []].some(item => item.kind === 'file')) { event.preventDefault(); }
		}));
		this._register(addDisposableListener(this.element, 'drop', event => {
			if (this.controlsDisabled(this.chat.state.get()) || !event.dataTransfer?.files.length) { return; }
			event.preventDefault();
			void this.chat.attachFiles([...event.dataTransfer.files]);
		}));
		this._register(addDisposableListener(this.attachmentList, 'click', event => {
			const button = (event.target as Element).closest<HTMLButtonElement>('button[data-attachment-id]');
			if (!button || button.disabled) { return; }
			this.editor.focus();
			if (button.dataset.attachmentAction === 'retry') { void this.chat.retryAttachment(button.dataset.attachmentId!); }
			else { this.chat.removeAttachment(button.dataset.attachmentId!); }
		}));
		const preview = h(container.ownerDocument, 'div');
		preview.className = 'ash-chat-dictation-preview';
		preview.setAttribute('aria-hidden', 'true');
		preview.hidden = true;
		container.insertBefore(preview, this.element);
		this.dictation = this._register(instantiation.createInstance(DictationInput, this.editor, preview, () => this.visible,
			async () => { await preferences.openSettings({ section: 'dictation' }); }, 'chat'));
		this.updateDictationHost();
		this._register(Event.any(speech.onDidChangeState, Event.map(this.dictation.onDidChange, () => speech.state))(() => this.renderToolbar()));
		this._register(speech.onDidChangePreparingModel(() => this.renderToolbar()));
		this._register(this.dictation.onDidEnd(error => {
			this.renderToolbar();
			if (error) { this.reportDictationError(error); }
		}));
		this._register(addDisposableListener(this.element, 'keydown', event => {
			if (event.key === 'Escape' && this.dictation.isActive) {
				event.preventDefault();
				event.stopPropagation();
				void this.cancelDictation();
			}
		}));
		this._register(this.editor.onDidChange(value => {
			// Restoring a service-owned draft also changes the editor model.
			if (value !== this.chat.state.get().draft) { this.chat.setDraft(value); }
		}));
		this._register(autorun(reader => {
			const state = this.chat.state.read(reader);
			// A new chat also replaces its parent ID while its conversation ID is still absent.
			const identity = JSON.stringify([state.conversationId, state.parentId]);
			if (identity !== this.inputIdentity || state.busy || state.sending) {
				this.inputGeneration++;
				void this.cancelDictation();
			}
			this.inputIdentity = identity;
			const voiceActive = state.voice !== 'idle';
			this.editor.setReadOnly(state.busy || state.sending || !!state.pendingCreation || voiceActive);
			this.editor.value = state.draft;
			this.renderAttachments(state.attachments, state.busy || state.sending);
			this.voiceStatus.hidden = !voiceActive;
			this.voiceStatus.textContent = state.voice === 'connecting' ? localize('sessions.chatgpt.voiceConnecting', 'Connecting voice…')
				: state.voice === 'connected' ? localize('sessions.chatgpt.voiceConnected', 'Voice conversation is active')
					: state.voice === 'stopping' ? localize('sessions.chatgpt.voiceStopping', 'Finishing voice conversation…') : '';
			this.voiceTranscript.hidden = !voiceActive || !state.voiceTranscript.length;
			this.voiceTranscript.textContent = state.voiceTranscript.map(item => localize('sessions.chatgpt.voiceTranscript', '{0}: {1}', item.role === 'user' ? localize('sessions.chatgpt.you', 'You') : 'ChatGPT', item.text)).join('\n');
			this.renderToolbar();
		}));
		this._register(toDisposable(() => { this.attachmentList.remove(); this.voiceStatus.remove(); this.voiceTranscript.remove(); preview.remove(); }));
	}

	private renderAttachments(attachments: readonly ChatGPTAttachment[], disabled: boolean): void {
		const ids = new Set(attachments.map(attachment => attachment.id));
		for (const [id, row] of this.attachmentRows) { if (!ids.has(id)) { row.element.remove(); this.attachmentRows.delete(id); } }
		for (const attachment of attachments) {
			let row = this.attachmentRows.get(attachment.id);
			if (!row) {
				const document = this.element.ownerDocument;
				const element = h(document, 'div'); element.className = 'ash-chatgpt-input-attachment'; element.setAttribute('role', 'listitem');
				const name = h(document, 'span'); name.className = 'ash-chatgpt-attachment-name';
				const status = h(document, 'span'); status.className = 'ash-chatgpt-attachment-status';
				const error = h(document, 'span'); error.className = 'ash-chatgpt-attachment-error';
				const retry = h(document, 'button', { className: 'ash-button ash-button-small ash-button-quiet' }); retry.type = 'button'; retry.dataset.attachmentId = attachment.id; retry.dataset.attachmentAction = 'retry';
				const remove = h(document, 'button', { className: 'ash-button ash-button-small ash-button-quiet' }); remove.type = 'button'; remove.dataset.attachmentId = attachment.id; remove.dataset.attachmentAction = 'remove'; appendIcon(Lxicon.close, remove);
				element.append(name, status, retry, remove, error); this.attachmentList.append(element);
				row = { element, name, status, retry, remove, error }; this.attachmentRows.set(attachment.id, row);
			}
			row.name.textContent = row.name.title = attachment.name;
			row.status.textContent = attachment.status === 'uploading' ? localize('sessions.chatgpt.uploading', 'Uploading…') : attachment.status === 'ready' ? localize('sessions.chatgpt.fileReady', 'Ready') : localize('sessions.chatgpt.fileFailed', 'Upload failed');
			row.error.textContent = attachment.error ?? ''; row.error.hidden = !attachment.error;
			row.retry.textContent = localize('sessions.chatgpt.retryUpload', 'Retry');
			row.retry.setAttribute('aria-label', localize('sessions.chatgpt.retryFile', 'Retry {0}', attachment.name)); row.retry.hidden = attachment.status !== 'failed'; row.retry.disabled = disabled;
			row.remove.setAttribute('aria-label', localize('sessions.chatgpt.removeFile', 'Remove {0}', attachment.name)); row.remove.title = row.remove.getAttribute('aria-label')!; row.remove.disabled = disabled;
		}
		this.attachmentList.hidden = attachments.length === 0;
	}

	private controlsDisabled(state: ChatGPTState): boolean {
		return !state.connected || !state.networkAvailable || !!state.pendingCreation || state.busy
			|| state.sending || state.managing || state.voice !== 'idle';
	}

	private renderToolbar(): void {
		const state = this.chat.state.get();
		const voiceActive = state.voice !== 'idle';
		const disabled = this.controlsDisabled(state);
		const attachLabel = localize('sessions.chatgpt.attachFiles', 'Attach files');
		const actions = [new ChatInputAction('ash.chatgpt.input.attach', attachLabel, attachLabel, Lxicon.add, !disabled, 'attach', () => this.filePicker.click())];
		if (this.dictation.showButton) {
			const dictation = this.dictation.action;
			const label = dictation.tooltip ?? dictation.label;
			const enabled = state.connected && !state.busy && !state.sending && !voiceActive && dictation.enabled;
			actions.push(new ChatInputAction('ash.chatgpt.input.dictate', label, label, Lxicon.mic, enabled, 'mic',
				() => { void dictation.run(); }, this.dictation.isActive));
		}

		const canSend = !state.pendingCreation && (isCoworkSubmission(state) || canQueueChatGPTCreation(state)
			|| state.connected && state.networkAvailable && !state.uncertain && state.attachments.every(attachment => attachment.status === 'ready'));
		const enabled = state.sending || voiceActive || (!state.coworkStarting && canSend && !state.busy && !state.managing);
		const hasInput = !!state.draft.trim() || state.attachments.length > 0 || this.dictation.isActive;
		const stopping = state.sending || voiceActive;
		const label = state.sending ? localize('sessions.chatgpt.stop', 'Stop') : voiceActive ? localize('sessions.chatgpt.stopVoice', 'Stop voice conversation')
			: hasInput ? localize('sessions.chatgpt.send', 'Send') : localize('sessions.chatgpt.startVoice', 'Voice conversation');
		actions.push(new ChatInputAction('ash.chatgpt.input.send', label, label,
			stopping ? Lxicon.primitiveSquare : hasInput ? Lxicon.arrowUp : Lxicon.voiceMode, enabled,
			stopping ? 'interrupt' : hasInput ? 'send' : 'voice',
			() => this.runPrimaryAction()));

		const ashModelsAvailable = CommandsRegistry.hasCommand(NEW_CHAT_WITH_MODEL_COMMAND);
		const modelEnabled = (!disabled && state.models.length > 0)
			|| (ashModelsAvailable && !state.sending && !state.managing && !state.busy && !state.coworkStarting && !voiceActive);
		this.modelAction.enabled = modelEnabled;
		// Keep unaffected controls and the model popup mounted while draft or upload state changes.
		const retained = actions.map(action => this.actions.find(previous =>
			previous.id === action.id && previous.label === action.label && previous.enabled === action.enabled
			&& previous.checked === action.checked && previous.presentation === action.presentation) ?? action);
		if (!equals(this.actions, retained)) {
			this.actions = retained;
			this.surface.attachmentToolbar!.setActions(retained.slice(0, 1));
			this.surface.inlineActionsToolbar!.setActions(retained.slice(1));
		}

		const selectedModel = state.models.find(model => model.id === state.model);
		this.modelPicker?.update({
			models: disabled ? noChatGPTModels : state.models, selectedModel: state.model, disabled: !modelEnabled,
			loadAshModels: ashModelsAvailable ? () => this.loadAshModels() : undefined,
			thinking: !disabled && selectedModel && selectedModel.presets.length > 1 && state.modelPreset !== undefined ? {
				levels: selectedModel.presets, selectedLevel: state.modelPreset,
				emphasized: selectedModel.presets.find(preset => preset.id === state.modelPreset)?.isPro,
				select: value => this.chat.setModelPreset(value),
			} : undefined,
		});
	}

	private async loadAshModels(): Promise<readonly { title: string; run(): void; }[]> {
		const scope = this.scopes.getProviderScope(LOCAL_AGENT_HOST_PROVIDER_ID);
		scope.assertCurrent();
		const models = await scope.services.models.listModels();
		scope.assertCurrent();
		return models.map(entry => ({
			title: entry.displayName,
			run: () => {
				const current = this.chat.state.get();
				const text = selectedChatConversationId(current) || current.pendingCreation || current.messages.length ? undefined : current.draft;
				void this.commands.executeCommand(NEW_CHAT_WITH_MODEL_COMMAND, { source: 'chatgpt', model: entry.model, text })
					.catch(error => this.notifications.error(error));
			},
		}));
	}

	private async runPrimaryAction(): Promise<void> {
		const state = this.chat.state.get();
		if (state.sending) await this.chat.stop();
		else if (state.voice !== 'idle') await this.chat.stopVoice();
		else if (state.draft.trim() || state.attachments.length || this.dictation.isActive) await this.submit();
		else await this.startVoice();
	}

	private async startVoice(): Promise<void> {
		await this.cancelDictation();
		if (this.visible && !this.isDisposed) { await this.chat.startVoice(this.element.ownerDocument.defaultView!); }
	}

	private reportDictationError(error: unknown): void {
		if (!this.isDisposed) { this.notifications.error(localize('sessions.chatgpt.dictationFailed', 'Dictation failed: {0}', String(error))); }
	}

	private async cancelDictation(): Promise<void> {
		try { await this.dictation.cancel(); }
		catch (error) { this.reportDictationError(error); }
	}

	private async submit(): Promise<void> {
		const generation = this.inputGeneration;
		try {
			// Stop commits the final transcript before sending; navigation retires this submission.
			await this.dictation.stop();
			notifyDictationSubmitted(this.editor.codeEditor);
			if (!this.isDisposed && this.visible && generation === this.inputGeneration) { await this.chat.send(); }
		} catch (error) { this.reportDictationError(error); }
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.updateDictationHost();
		if (visible) { this.editor.layout(); }
		else {
			this.modelPicker?.hide();
			this.inputGeneration++;
			void this.cancelDictation();
			void this.chat.stopVoice();
		}
	}

	private updateDictationHost(): void {
		if (!this.visible) this.dictationHost.clear();
		else if (!this.dictationHost.value) this.dictationHost.value = this.onboarding.registerHost({ container: this.container, focusRoot: this.container, focus: () => this.editor.focus() });
	}

	protected override disposeCore(): void {
		this.setVisible(false);
		super.disposeCore();
	}

	focus(): void {
		// Read-only loading states retain the text focus target without focusing the form.
		this.editor.focus();
	}
}

/** Mounts the provider's model selector in the shared toolbar's focus lifecycle. */
class ChatGPTModelPickerActionItem extends ActionViewItem {
	private widget: ModelPickerWidget | undefined;

	constructor(action: IAction, private readonly create: (container: HTMLElement) => ModelPickerWidget) {
		super(action);
	}

	override render(container: HTMLElement): void {
		container.classList.add('ash-chat-input-model-selector');
		this.widget = this._register(this.create(container));
	}

	override focus(): void { this.widget?.focus(); }
	override setTabbable(tabbable: boolean): void { this.widget?.setTabbable(tabbable); }
}
