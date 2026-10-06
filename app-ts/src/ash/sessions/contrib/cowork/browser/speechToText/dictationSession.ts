import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { isModelPreparing, type ILocalTranscriptionModelSnapshot } from '../../../../../platform/localTranscription/common/localTranscription.js';
import { localize } from '../../../../../nls.js';
import { IDictationOnboardingService } from './dictationOnboarding.js';
import { IChatSpeechToTextService, ChatSpeechToTextState } from './chatSpeechToTextService.js';

/** The target editor owns text and undo history; interim recognition stays outside its model. */
interface DictationTarget { insertText(text: string): void; focus(): void; }

export class DictationSession extends Disposable {
	private active = false;
	private preparing = false;
	private committedText = '';
	private readonly ended = this._register(new Emitter<string | undefined>());
	public readonly onDidEnd = this.ended.event;
	public getAccessibleContent(): string { return this.committedText + this.preview.textContent; }
	public get isActive(): boolean { return this.active; }
	public readonly action: IAction;

	constructor(
		private readonly editor: DictationTarget,
		private readonly preview: HTMLElement,
		private readonly isVisible: () => boolean,
		private readonly showPreparation: (snapshot: ILocalTranscriptionModelSnapshot) => Promise<void>,
		@IChatSpeechToTextService private readonly service: IChatSpeechToTextService,
		@IDictationOnboardingService private readonly onboarding: IDictationOnboardingService,
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
		if (this.preparing) { return; }
		try {
			if (this.active) { await this.stop(); return; }
			if (!this.service.isConfigured) { throw new Error(localize('chat.input.dictationUnavailable', 'Dictation is unavailable')); }
			if (this.service.isBusy) { return; }
			this.preparing = true;
			const preparation = await this.service.getPreparation();
			if (this.isDisposed || !this.isVisible() || this.service.isBusy) { return; }
			if (preparation && (!preparation.available || isModelPreparing(preparation.status))) {
				await this.showPreparation(preparation);
				return;
			}
			if (!this.onboarding.showIfNeeded()) { await this.start(); }
		} catch (error) {
			if (!this.isDisposed) { this.ended.fire(String(error)); }
		} finally {
			this.preparing = false;
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

/** Shared help follows the focused capture target, while its binding remains the transcript owner. */
export class DictationAccessibilityHelp extends Disposable {
	constructor(
		session: DictationSession,
		target: HTMLElement,
		surface: HTMLElement,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
	) {
		super();
		const focused = contextKeys.createKey<boolean>('dictationTargetFocused', false);
		focused.set(true);
		this._register(toDisposable(() => focused.reset()));
		const id = generateUuid();
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type,
				priority: 115,
				name: `dictation-target-${id}-${type}`,
				when: ContextKeyExpr.has('dictationTargetFocused'),
				getProvider: () => {
					const focused = target.ownerDocument.activeElement as HTMLElement;
					if (!session.isActive || !target.contains(focused)) { return undefined; }
					return new AccessibleContentProvider(
						AccessibleViewProviderId.Dictation,
						{ type },
						() => type === AccessibleViewType.Help
							? localize('dictation.targetHelp', 'Dictation is active. Completed phrases are inserted at the current editor selection or into terminal input. Terminal dictation never presses Enter. Use Tab to reach Stop and Cancel. Escape cancels recording and discards unfinished text. Use <keybinding:editor.action.accessibleView> to read the transcript.')
							: session.getAccessibleContent(),
						() => focused.focus(),
						AccessibilityVerbositySettingId.Dictation,
					);
				},
			}));
		}
		const hint = accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.Dictation);
		surface.setAttribute('role', 'region');
		surface.setAttribute('aria-label', localize('dictation.controls', 'Dictation controls'));
		if (hint) { surface.setAttribute('aria-description', hint); }
	}
}
