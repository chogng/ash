import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { isModelPreparing, type ILocalTranscriptionModelSnapshot } from '../../../../../platform/localTranscription/common/localTranscription.js';
import { localize } from '../../../../../nls.js';
import type { IChatInputEditor } from '../widget/input/chatInputEditorRegistry.js';
import { IChatSpeechToTextService, ChatSpeechToTextState } from './chatSpeechToTextService.js';

/** The target editor owns text and undo history; interim recognition stays outside its model. */
export class DictationSession extends Disposable {
	private active = false;
	private committedText = '';
	private readonly ended = this._register(new Emitter<string | undefined>());
	public readonly onDidEnd = this.ended.event;
	public get isActive(): boolean { return this.active; }
	public readonly action: IAction;

	constructor(
		private readonly editor: IChatInputEditor,
		private readonly preview: HTMLElement,
		private readonly isVisible: () => boolean,
		private readonly showPreparation: (snapshot: ILocalTranscriptionModelSnapshot) => Promise<void>,
		@IChatSpeechToTextService private readonly service: IChatSpeechToTextService,
	) {
		super();
		const session = this;
		this.action = {
			id: 'ash.chat.input.mic',
			get label() { return localize('chat.input.dictate', 'Dictate message'); },
			get tooltip() {
				if (session.active) { return localize('chat.input.dictationStop', 'Stop dictation'); }
				return service.isConfigured ? localize('chat.input.dictate', 'Dictate message') : localize('chat.input.dictationUnavailable', 'Dictation is unavailable');
			},
			icon: Lxicon.mic,
			get enabled() { return service.isConfigured && (!service.isBusy || session.active) && !service.isStarting && service.state !== ChatSpeechToTextState.Transcribing; },
			get checked() { return session.active && service.state === ChatSpeechToTextState.Recording; },
			run: () => this.toggle(),
		};
		const clearPreview = (): void => { preview.textContent = ''; preview.hidden = true; };
		this._register(service.onDidUpdateTranscript(({ text, finalizedText }) => {
			if (!this.active || !isVisible()) { return; }
			const phrase = finalizedText.slice(this.committedText.length);
			this.committedText = finalizedText;
			preview.textContent = text.slice(finalizedText.length);
			preview.hidden = !preview.textContent;
			if (phrase) {
				editor.insertText(phrase);
				editor.focus();
				status(localize('chat.input.dictationInserted', 'Dictation added to message'));
			}
		}));
		this._register(service.onDidEnd(error => { if (this.active) { this.ended.fire(error); } }));
		this._register(service.onDidChangeState(state => {
			if (state === ChatSpeechToTextState.Idle) {
				this.active = false;
				clearPreview();
			}
		}));
	}

	private async toggle(): Promise<void> {
		try {
			if (this.active) { await this.stop(); return; }
			if (this.service.isBusy) { return; }
			const preparation = await this.service.getPreparation();
			if (this.isDisposed || !this.isVisible()) { return; }
			if (preparation && (!preparation.available || isModelPreparing(preparation.status))) {
				await this.showPreparation(preparation);
				return;
			}
			await this.start();
		} catch (error) {
			if (!this.isDisposed) { this.ended.fire(String(error)); }
		}
	}

	public async start(): Promise<void> {
		if (this.service.isBusy) { return; }
		this.active = true;
		this.committedText = '';
		try {
			await this.service.start();
		} catch (error) {
			this.active = false;
			throw error;
		}
	}

	public async stop(): Promise<void> {
		if (this.active) { await this.service.stopAndTranscribe(); }
	}

	public async cancel(): Promise<void> {
		if (!this.active) { return; }
		this.active = false;
		this.preview.textContent = '';
		this.preview.hidden = true;
		await this.service.cancel();
	}

	protected override disposeCore(): void {
		void this.cancel().catch(() => undefined);
		super.disposeCore();
	}
}
