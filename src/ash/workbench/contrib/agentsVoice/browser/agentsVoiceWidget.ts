import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import type { AgentVoiceInputMode, AgentVoiceTranscript } from '../../../../platform/agentHost/common/agentService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { VoiceModeOnboardingBanner } from './voiceModeOnboarding.js';

export interface VoiceWidgetCallbacks {
	openSession(): void;
	connect?(): void;
	toggleMute(): void;
	toggleInputMode(): void;
	pttDown(): void;
	pttUp(): void;
	disconnect(): void;
	stopPlayback(): void;
	closeWindow(): void;
	showSessionsPicker(): void;
}

export interface VoiceWidgetOptions {
	readonly showClose?: boolean;
	readonly showOnboarding?: boolean;
	readonly inputBoxLayout?: boolean;
}

/** A view of the original connection and transcript, with no media or persistence owner. */
export class AgentsVoiceWidget extends Disposable {
	readonly element: HTMLElement;
	private readonly status: HTMLElement;
	private readonly transcript: HTMLElement;
	private readonly disconnect: Button;
	private readonly interrupt: Button;
	private readonly openChat: Button;
	private readonly mute: Button;
	private readonly mode: Button;
	private readonly ptt: Button;
	private connected = false;
	private muted = false;
	private inputMode: AgentVoiceInputMode = 'openMic';
	private holding = false;
	private readonly rows = new Map<string, HTMLElement>();

	constructor(container: HTMLElement, private readonly callbacks: VoiceWidgetCallbacks, options: VoiceWidgetOptions,
		@IInstantiationService instantiation: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IConfigurationService configuration: IConfigurationService,
	) {
		super();
		const document = container.ownerDocument;
		this.element = h(document, 'section');
		this.element.className = 'ash-agents-voice';
		if (options.inputBoxLayout) this.element.style.cssText = 'height:auto;flex:0 0 auto';
		this.element.setAttribute('aria-label', localize('agentsVoice.title', 'Voice conversation'));
		// The sheet belongs to this component and travels with it into an auxiliary document.
		const style = h(document, 'style');
		style.textContent = `
.ash-agents-voice {
	box-sizing: border-box;
	display: flex;
	flex-direction: column;
	width: 100%;
	height: 100%;
	min-width: 0;
	min-height: 0;
	gap: var(--ash-spacing-size120);
	padding: var(--ash-spacing-size160);
	color: var(--ash-foreground);
	background: var(--ash-editor-background);
	font-size: var(--ash-fontSize-body1);
}

.ash-agents-voice[hidden], .ash-agents-voice [hidden] {
	display: none;
}

.ash-agents-voice-header, .ash-agents-voice-controls {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--ash-spacing-size80);
}

.ash-agents-voice h2 {
	margin: 0;
	font-size: var(--ash-fontSize-heading3);
	font-weight: var(--ash-fontWeight-semiBold);
}

.ash-agents-voice-header h2 {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.ash-agents-voice-status {
	overflow-wrap: anywhere;
	color: var(--ash-description-foreground);
}

.ash-agents-voice-transcript {
	flex: 1;
	min-height: 0;
	min-width: 0;
	overflow: auto;
	padding: var(--ash-spacing-size80);
	border: var(--ash-strokeThickness) solid var(--ash-contrastBorder, transparent);
	border-radius: var(--ash-cornerRadius-medium);
}

.ash-agents-voice-row {
	margin: 0 0 var(--ash-spacing-size120);
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}

.ash-agents-voice-row strong {
	font-weight: var(--ash-fontWeight-semiBold);
}

.ash-agents-voice-introduction {
	padding: var(--ash-spacing-size120);
	border: var(--ash-strokeThickness) solid var(--ash-contrastBorder, var(--ash-border));
	border-radius: var(--ash-cornerRadius-medium);
}

.ash-agents-voice-introduction[hidden] {
	display: none;
}

.ash-agents-voice-introduction p {
	margin: var(--ash-spacing-size80) 0;
}

.ash-agents-voice-transcript:focus-visible {
	outline: var(--ash-strokeThickness) solid var(--ash-focusBorder);
	outline-offset: -1px;
}
`;
		const header = h(document, 'div');
		header.className = 'ash-agents-voice-header';
		const title = h(document, 'h2');
		title.textContent = localize('agentsVoice.title', 'Voice conversation');
		header.append(title);
		if (options.showClose !== false) this._register(new Button(header, { label: localize('agentsVoice.close', 'Close window'), onClick: callbacks.closeWindow }));
		header.hidden = options.inputBoxLayout === true;
		this.status = h(document, 'div');
		this.status.className = 'ash-agents-voice-status';
		this.status.setAttribute('role', 'status');
		const controls = h(document, 'div');
		controls.className = 'ash-agents-voice-controls';
		this.openChat = this._register(new Button(controls, { label: localize('agentsVoice.openChat', 'Open Chat'), onClick: callbacks.openSession }));
		this.openChat.domNode.hidden = options.inputBoxLayout === true;
		if (callbacks.connect) this._register(new Button(controls, { label: localize('agentsVoice.start', 'Start voice'), onClick: callbacks.connect }));
		this.mute = this._register(new Button(controls, { label: localize('agentsVoice.mute', 'Mute microphone'), enabled: false, onClick: callbacks.toggleMute }));
		this.mode = this._register(new Button(controls, { label: localize('agentsVoice.usePtt', 'Use push to talk'), enabled: false, checked: false, onClick: callbacks.toggleInputMode }));
		this.ptt = this._register(new Button(controls, { label: localize('agentsVoice.hold', 'Hold to speak'), enabled: false, checked: false }));
		this.interrupt = this._register(new Button(controls, { label: localize('agentsVoice.interrupt', 'Interrupt reply'), enabled: false, onClick: callbacks.stopPlayback }));
		this.disconnect = this._register(new Button(controls, { label: localize('agentsVoice.disconnect', 'Disconnect'), enabled: false, onClick: callbacks.disconnect }));
		if (!options.inputBoxLayout) this._register(new Button(controls, { label: localize('agentsVoice.sessions', 'Conversations'), onClick: callbacks.showSessionsPicker }));
		this.transcript = h(document, 'div');
		this.transcript.className = 'ash-agents-voice-transcript';
		this.transcript.tabIndex = 0;
		this.transcript.setAttribute('role', 'region');
		this.transcript.setAttribute('aria-label', localize('agentsVoice.transcript', 'Voice transcript'));
		this.element.append(style, header, this.status, controls);
		if (options.showOnboarding !== false) this._register(instantiation.createInstance(VoiceModeOnboardingBanner, this.element, () => this.openChat.focus()));
		this.element.append(this.transcript);
		this.transcript.hidden = options.inputBoxLayout === true;
		container.append(this.element);
		this.setTranscriptTurns([]);
		const release = () => { if (this.holding) { this.holding = false; callbacks.pttUp(); } };
		const press = () => { if (!this.holding && this.ptt.enabled) { this.holding = true; callbacks.pttDown(); } };
		this._register(addDisposableListener(this.ptt.domNode, 'pointerdown', event => {
			if (event.button !== 0 || !this.ptt.enabled) return;
			this.ptt.domNode.setPointerCapture(event.pointerId);
			press();
		}));
		for (const type of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur'] as const) this._register(addDisposableListener(this.ptt.domNode, type, release));
		this._register(addDisposableListener(this.ptt.domNode, 'keydown', event => {
			if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
			if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); if (!event.repeat) press(); }
		}));
		this._register(addDisposableListener(this.ptt.domNode, 'keyup', event => {
			if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); release(); }
		}));
		this._register(addDisposableListener(document.defaultView!, 'blur', release));
		this._register(toDisposable(release));
		const scope = this._register(contextKeys.createScoped(this.element));
		const focusedKey = new RawContextKey<boolean>('agentsVoiceWidgetFocused', false);
		const focused = focusedKey.bindTo(scope);
		this._register(addDisposableListener(this.element, 'focusin', () => {
			focused.set(true);
			if (configuration.getValue<boolean>(AccessibilityVerbositySettingId.AgentsVoice) !== false) {
				this.element.setAttribute('aria-description', localize('agentsVoice.helpHint', 'Use the accessibility help command for voice conversation controls.'));
			} else this.element.removeAttribute('aria-description');
		}));
		this._register(addDisposableListener(this.element, 'focusout', event => {
			if (!this.element.contains(event.relatedTarget as Node | null)) focused.reset();
		}));
		this._register(addDisposableListener(this.element, 'keydown', event => {
			if (event.key === 'Escape') { event.preventDefault(); callbacks.closeWindow(); }
		}));
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				name: `agentsVoice-${generateUuid()}`, type, priority: 110, when: focusedKey.isEqualTo(true),
				getProvider: () => {
					const focusedElement = document.activeElement;
					if (!this.element.contains(focusedElement)) return undefined;
					return new AccessibleContentProvider(AccessibleViewProviderId.AgentsVoice, { type },
						() => type === AccessibleViewType.Help
							? (options.inputBoxLayout ? localize('agentsVoice.inputBoxHelp', 'Use Tab and Shift+Tab to move between voice controls. Interrupt reply stops the spoken reply. Disconnect ends voice while preserving your Chat task, draft and attachments. Escape returns focus to the Chat input.') : localize('agentsVoice.help', 'Use Tab and Shift+Tab to move between voice controls. Enter or Space activates a button. Open Chat returns to the conversation where you can start voice and choose a provider, model and voice. Interrupt reply stops the current spoken reply. Disconnect ends voice without interrupting a Chat task. Conversations opens the conversation picker. The transcript contains the original spoken text and can be read in the accessible view. Escape closes this window; the voice conversation continues in Chat.')) + '\n' + localize('agentsVoice.inputHelp', 'Mute microphone closes audio input while keeping the connection and spoken replies. Switch between open microphone and push to talk. In push to talk mode, focus Hold to speak and hold Space or Enter to record; release to finish. Losing focus, cancelling the pointer or closing the window also ends this recording. The push to talk shortcut is <keybinding:agentsVoice.pushToTalk>.')
							: `${this.status.textContent}\n\n${this.rows.size ? [...this.rows.values()].map(row => row.textContent).join('\n\n') : this.transcript.textContent}`,
						() => { if (focusedElement instanceof document.defaultView!.HTMLElement && focusedElement.isConnected) focusedElement.focus(); },
						AccessibilityVerbositySettingId.AgentsVoice);
				},
			}));
		}
		this._register(toDisposable(() => this.element.remove()));
		if (!options.inputBoxLayout) this.openChat.focus();
	}

	setConnected(connected: boolean): void {
		const restoreFocus = !connected && [this.mute, this.mode, this.ptt, this.interrupt].some(button => button.hasFocus());
		this.connected = connected;
		this.mute.enabled = this.mode.enabled = connected;
		this.updateInput();
		this.interrupt.enabled = connected;
		if (restoreFocus) this.openChat.focus();
	}
	setConnecting(connecting: boolean): void {
		const enabled = connecting || this.interrupt.enabled;
		const restoreFocus = !enabled && this.disconnect.hasFocus();
		this.disconnect.enabled = enabled;
		if (restoreFocus) this.openChat.focus();
	}
	setStatusText(text: string): void { if (this.status.textContent !== text) this.status.textContent = text; }
	setMuted(muted: boolean): void { this.muted = muted; this.updateInput(); }
	setInputMode(mode: AgentVoiceInputMode): void { this.inputMode = mode; this.updateInput(); }
	setVoiceState(state: 'listening' | 'idle'): void { this.ptt.checked = this.inputMode === 'pushToTalk' && state === 'listening'; }
	private updateInput(): void {
		this.mute.checked = this.muted;
		this.mute.label = this.muted ? localize('agentsVoice.unmute', 'Unmute microphone') : localize('agentsVoice.mute', 'Mute microphone');
		this.mode.checked = this.inputMode === 'pushToTalk';
		this.mode.label = this.inputMode === 'pushToTalk' ? localize('agentsVoice.useOpenMic', 'Use open microphone') : localize('agentsVoice.usePtt', 'Use push to talk');
		const enabled = this.connected && !this.muted && this.inputMode === 'pushToTalk';
		const restoreFocus = !enabled && this.ptt.hasFocus();
		this.ptt.enabled = enabled;
		if (!this.ptt.enabled && this.holding) { this.holding = false; this.callbacks.pttUp(); }
		if (restoreFocus && this.connected) this.mute.focus();
	}

	setTranscriptTurns(turns: readonly AgentVoiceTranscript[]): void {
		const wasAtBottom = this.transcript.scrollHeight - this.transcript.clientHeight - this.transcript.scrollTop <= 4;
		const ids = new Set(turns.map(turn => turn.itemId));
		for (const [id, row] of this.rows) {
			if (!ids.has(id)) { row.remove(); this.rows.delete(id); }
		}
		if (!turns.length) {
			this.transcript.textContent = localize('agentsVoice.transcript.empty', 'Spoken text appears here after you start voice in Chat.');
			return;
		}
		if (!this.rows.size) this.transcript.replaceChildren();
		for (const turn of turns) {
			let row = this.rows.get(turn.itemId);
			if (!row) {
				row = h(this.element.ownerDocument, 'p');
				row.className = 'ash-agents-voice-row';
				row.append(h(this.element.ownerDocument, 'strong'), h(this.element.ownerDocument, 'span'));
				this.rows.set(turn.itemId, row);
			}
			const speaker = turn.speaker === 'user' ? localize('agentsVoice.speaker.user', 'You') : localize('agentsVoice.speaker.assistant', 'Agent');
			row.children[0]!.textContent = `${speaker}: `;
			row.children[1]!.textContent = turn.text;
			// Reorder existing nodes without losing the transcript's focus or interpreting speech as markup.
			this.transcript.append(row);
		}
		if (wasAtBottom) this.transcript.scrollTop = this.transcript.scrollHeight;
	}
}
