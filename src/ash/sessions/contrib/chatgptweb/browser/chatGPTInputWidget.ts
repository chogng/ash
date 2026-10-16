import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ChatInputEditor } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputEditor.js';
import { DictationSession } from '../../../../workbench/contrib/chat/browser/speechToText/dictationSession.js';
import { IDictationOnboardingService } from '../../../../workbench/contrib/chat/browser/speechToText/dictationOnboarding.js';
import { SkillSelectorCatalog } from '../../../../workbench/contrib/chat/common/skillSelectors.js';
import { SlashCommandCatalog } from '../../../../workbench/contrib/chat/common/slashCommands.js';
import { IChatSpeechToTextService } from '../../../../workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { IPreferencesService } from '../../../../workbench/services/preferences/common/preferences.js';
import { IChatGPTService, type ChatGPTAttachment } from './chatGPTService.js';
import { ModelPickerWidget } from '../../chat/browser/modelPickerWidget.js';
import '../../../common/theme.js';
import './media/chatGPTInputWidget.css';

/** Owns the ChatGPT composer controls; the service retains drafts and request state. */
export class ChatGPTInputWidget extends Disposable {
	private readonly element: HTMLFormElement;
	private readonly editor: ChatInputEditor;
	private readonly modelPicker: ModelPickerWidget;
	private readonly sendButton: HTMLButtonElement;
	private readonly dictationButton: HTMLButtonElement;
	private readonly dictation: DictationSession;
	private readonly attachButton: HTMLButtonElement;
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
		@IChatSpeechToTextService speech: IChatSpeechToTextService,
		@IDictationOnboardingService private readonly onboarding: IDictationOnboardingService,
		@IPreferencesService preferences: IPreferencesService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.element = h(container.ownerDocument, 'form');
		this.element.className = 'ash-chatgpt-composer';
		container.append(this.element);
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
		const picker = h(container.ownerDocument, 'input');
		picker.type = 'file'; picker.multiple = true; picker.hidden = true;
		this.attachButton = h(container.ownerDocument, 'button');
		this.attachButton.type = 'button';
		this.attachButton.className = 'ash-chatgpt-add ash-chatgpt-round-button';
		const attachLabel = localize('sessions.chatgpt.attachFiles', 'Attach files');
		this.attachButton.setAttribute('aria-label', attachLabel); this.attachButton.title = attachLabel;
		appendIcon(Lxicon.add, this.attachButton);
		this.element.append(this.attachButton, picker);
		this._register(addDisposableListener(this.attachButton, 'click', () => picker.click()));
		this._register(addDisposableListener(picker, 'change', () => {
			const files = [...picker.files ?? []]; picker.value = '';
			void this.chat.attachFiles(files);
		}));
		this._register(addDisposableListener(this.element, 'paste', event => {
			if (this.attachButton.disabled || !event.clipboardData?.files.length) { return; }
			event.preventDefault();
			void this.chat.attachFiles([...event.clipboardData.files]);
		}));
		this._register(addDisposableListener(this.element, 'dragover', event => {
			if (!this.attachButton.disabled && [...event.dataTransfer?.items ?? []].some(item => item.kind === 'file')) { event.preventDefault(); }
		}));
		this._register(addDisposableListener(this.element, 'drop', event => {
			if (this.attachButton.disabled || !event.dataTransfer?.files.length) { return; }
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
		const input = h(container.ownerDocument, 'div');
		input.className = 'ash-chatgpt-input';
		this.element.append(input);
		const prompt = localize('sessions.chatgpt.prompt', 'Ask ChatGPT');
		this.editor = this._register(instantiation.createInstance(ChatInputEditor, {
			container: input,
			placeholder: prompt,
			ariaLabel: prompt,
			// ChatGPT sends plain prompts and has no Agent commands or skill selectors.
			slashCommands: new SlashCommandCatalog([], []),
			skills: new SkillSelectorCatalog(),
			height: { minimum: 20, maximum: 240 },
			tabFocusMode: true,
		}));
		this.modelPicker = this._register(instantiation.createInstance(ModelPickerWidget, this.element, (model: string) => this.chat.setModel(model)));
		const preview = h(container.ownerDocument, 'div');
		preview.className = 'ash-chatgpt-dictation-preview';
		preview.setAttribute('aria-hidden', 'true');
		preview.hidden = true;
		input.append(preview);
		this.dictation = this._register(instantiation.createInstance(DictationSession, this.editor, preview, () => this.visible,
			async () => { await preferences.openSettings({ section: 'dictation' }); }, 'chat'));
		this._register(onboarding.registerHost({ container, focusTarget: this.element, isVisible: () => this.visible }));
		this.dictationButton = h(container.ownerDocument, 'button');
		this.dictationButton.className = 'ash-chatgpt-dictation ash-chatgpt-round-button';
		this.dictationButton.type = 'button';
		appendIcon(Lxicon.mic, this.dictationButton);
		this._register(addDisposableListener(this.dictationButton, 'click', () => { void this.dictation.action.run(); }));
		this._register(speech.onDidChangeState(() => this.renderDictation()));
		this._register(speech.onDidChangePreparation(() => this.renderDictation()));
		this._register(this.dictation.onDidEnd(error => {
			this.renderDictation();
			if (error) { this.reportDictationError(error); }
		}));
		this._register(addDisposableListener(this.element, 'keydown', event => {
			if (event.key === 'Escape' && this.dictation.isActive) {
				event.preventDefault();
				event.stopPropagation();
				void this.cancelDictation();
			}
		}));
		this.sendButton = h(container.ownerDocument, 'button');
		this.sendButton.className = 'ash-chatgpt-send ash-chatgpt-round-button';
		this.sendButton.type = 'button';
		this.element.append(this.dictationButton, this.sendButton);
		this._register(addDisposableListener(this.sendButton, 'click', () => {
			const state = this.chat.state.get();
			if (state.sending) { void this.chat.stop(); }
			else if (state.voice !== 'idle') { void this.chat.stopVoice(); }
			else if (state.draft.trim() || state.attachments.length || this.dictation.isActive) { void this.submit(); }
			else { void this.startVoice(); }
		}));
		this._register(addDisposableListener(this.element, 'submit', event => { event.preventDefault(); }));
		this._register(this.editor.onDidSubmit(() => { void this.submit(); }));
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
			this.editor.setReadOnly(!state.connected || state.busy || state.sending || voiceActive);
			this.attachButton.disabled = !state.connected || state.busy || state.sending || voiceActive;
			const selectedModel = state.models.find(model => model.id === state.model);
			this.modelPicker.update({
				models: state.models, selectedModel: state.model, disabled: this.attachButton.disabled,
				thinking: selectedModel && selectedModel.presets.length > 1 && state.modelPreset !== undefined ? {
					levels: selectedModel.presets, selectedLevel: state.modelPreset,
					emphasized: selectedModel.presets.find(preset => preset.id === state.modelPreset)?.isPro,
					select: value => this.chat.setModelPreset(value),
				} : undefined,
			});
			this.editor.value = state.draft;
			this.renderAttachments(state.attachments, state.busy || state.sending);
			this.voiceStatus.hidden = !voiceActive;
			this.voiceStatus.textContent = state.voice === 'connecting' ? localize('sessions.chatgpt.voiceConnecting', 'Connecting voice…')
				: state.voice === 'connected' ? localize('sessions.chatgpt.voiceConnected', 'Voice conversation is active') : '';
			this.voiceTranscript.hidden = !voiceActive || !state.voiceTranscript.length;
			this.voiceTranscript.textContent = state.voiceTranscript.map(item => localize('sessions.chatgpt.voiceTranscript', '{0}: {1}', item.role === 'user' ? localize('sessions.chatgpt.you', 'You') : 'ChatGPT', item.text)).join('\n');
			this.renderDictation();
		}));
		this._register(toDisposable(() => { this.element.remove(); this.attachmentList.remove(); this.voiceStatus.remove(); this.voiceTranscript.remove(); }));
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
				const retry = h(document, 'button'); retry.type = 'button'; retry.dataset.attachmentId = attachment.id; retry.dataset.attachmentAction = 'retry';
				const remove = h(document, 'button'); remove.type = 'button'; remove.dataset.attachmentId = attachment.id; remove.dataset.attachmentAction = 'remove'; appendIcon(Lxicon.close, remove);
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

	private renderSend(): void {
		const state = this.chat.state.get();
		const voiceActive = state.voice !== 'idle';
		this.sendButton.disabled = !state.sending && !voiceActive && (!state.connected || state.busy || state.uncertain || state.attachments.some(attachment => attachment.status !== 'ready'));
		const hasInput = !!state.draft.trim() || state.attachments.length > 0 || this.dictation.isActive;
		const sendLabel = state.sending ? localize('sessions.chatgpt.stop', 'Stop') : voiceActive ? localize('sessions.chatgpt.stopVoice', 'Stop voice conversation')
			: hasInput ? localize('sessions.chatgpt.send', 'Send') : localize('sessions.chatgpt.startVoice', 'Voice conversation');
		if (this.sendButton.getAttribute('aria-label') !== sendLabel) {
			this.sendButton.setAttribute('aria-label', sendLabel);
			this.sendButton.title = sendLabel;
			this.sendButton.replaceChildren();
			appendIcon(state.sending || voiceActive ? Lxicon.primitiveSquare : hasInput ? Lxicon.arrowUp : Lxicon.voiceMode, this.sendButton);
		}
	}

	private renderDictation(): void {
		const state = this.chat.state.get();
		this.dictationButton.disabled = !state.connected || state.busy || state.sending || state.voice !== 'idle' || !this.dictation.action.enabled;
		const label = this.dictation.action.tooltip ?? this.dictation.action.label;
		this.dictationButton.setAttribute('aria-label', label);
		this.dictationButton.setAttribute('aria-pressed', String(this.dictation.isActive));
		this.dictationButton.title = label;
		this.renderSend();
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
			if (!this.isDisposed && this.visible && generation === this.inputGeneration) { await this.chat.send(); }
		} catch (error) { this.reportDictationError(error); }
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		if (visible) { this.editor.layout(); }
		else {
			this.modelPicker.hide();
			this.inputGeneration++;
			void this.cancelDictation();
			void this.chat.stopVoice();
			this.onboarding.hide(this.container);
		}
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
