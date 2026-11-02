import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { ActionViewItem } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import type { Button } from '../../../../../base/browser/ui/button/button.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { Event } from '../../../../../base/common/event.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { autorun, observableFromEvent, type IObservable } from '../../../../../base/common/observable.js';
import { IAgentVoiceService } from '../../../../../platform/agentHost/common/agentService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { AGENTS_VOICE_TOGGLE_MUTE_COMMAND_ID } from '../../../agentsVoice/common/agentsVoice.js';
import { IChatSpeechToTextService, ChatSpeechToTextState } from '../speechToText/chatSpeechToTextService.js';
import { addMicButtonContextMenuListener, getDictationContextMenuActions } from '../speechToText/micButtonMenuActions.js';
import { IVoiceInputModeService, type VoiceInputMode } from './voiceInputMode.js';
import { localize } from '../../../../../nls.js';
import './media/voiceInputMode.css';

export interface IVoiceInputModePillOptions {
	readonly toggleDictation?: () => void;
	readonly isActive?: IObservable<boolean>;
	readonly isDictationActive?: IObservable<boolean>;
	readonly isVoiceActive?: IObservable<boolean>;
}

/** The host action targets its own Chat; this view only projects state and routes gestures. */
export class VoiceInputModeActionViewItem extends ActionViewItem {
	private readonly buttons: Button[] = [];
	private tabbable = false;

	constructor(
		action: IAction,
		private readonly options: IVoiceInputModePillOptions | undefined,
		@IVoiceInputModeService private readonly modes: IVoiceInputModeService,
		@IAgentVoiceService private readonly voice: IAgentVoiceService | undefined,
		@IChatSpeechToTextService private readonly dictation: IChatSpeechToTextService,
		@ICommandService private readonly commands: ICommandService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IKeybindingService private readonly keybindings: IKeybindingService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
	) {
		super(action);
	}

	public override render(container: HTMLElement): void {
		container.classList.add('ash-voice-input-mode');
		container.setAttribute('role', 'group');
		container.setAttribute('aria-label', localize({ bundle: 'ash', key: 'voiceInputMode.label' }, 'Voice input'));
		const dictation = this.createButton(container, { label: '', icon: Lxicon.mic, iconOnly: true });
		const power = this.createButton(container, { label: '', icon: Lxicon.voiceMode, iconOnly: true });
		const mute = this.createButton(container, { label: '', icon: Lxicon.mic, iconOnly: true });
		const dictationHover = this.setupHover(dictation.domNode, '');
		const powerHover = this.setupHover(power.domNode, '');
		const muteHover = this.setupHover(mute.domNode, '');
		this.buttons.push(dictation, power, mute);
		const capture = observableFromEvent(this, this.dictation.onDidChangeState, () => this.dictation.state);
		const connection = observableFromEvent(this, this.voice?.onDidChange ?? Event.None, () => this.voice?.state);
		this._register(autorun(reader => {
			const selected = this.modes.selectedMode.read(reader);
			const state = connection.read(reader);
			const ownsInput = this.options?.isActive?.read(reader) ?? true;
			const ownsVoice = this.options?.isVoiceActive?.read(reader) ?? ownsInput;
			const ownsDictation = this.options?.isDictationActive?.read(reader) ?? ownsInput;
			const voiceActive = ownsVoice && (state?.state === 'connecting' || state?.state === 'connected');
			const captureState = capture.read(reader);
			const dictationActive = ownsDictation && this.dictation.isBusy;
			dictation.hidden = !this.modes.dictationAvailable.read(reader);
			dictation.enabled = captureState !== ChatSpeechToTextState.Transcribing &&
				!(dictationActive && captureState === ChatSpeechToTextState.Idle) &&
				(!this.dictation.isBusy || ownsDictation) &&
				(!state || state.state === 'ended' || state.state === 'failed' || ownsVoice);
			dictation.label = dictationActive ? localize('chat.input.dictationStop', 'Stop dictation') : localize('chat.input.dictate', 'Dictate message');
			dictation.checked = dictationActive;
			dictation.domNode.dataset.selected = String(selected === 'dictation');
			power.hidden = !this.modes.voiceAvailable.read(reader) && !voiceActive;
			power.enabled = this.action.enabled && (voiceActive || !this.dictation.isBusy || ownsDictation);
			power.label = voiceActive ? localize('chat.voice.stop', 'Stop voice conversation') : localize('chat.input.voice', 'Voice conversation');
			power.checked = voiceActive;
			power.domNode.dataset.selected = String(selected === 'voice');
			power.domNode.setAttribute('aria-busy', String(voiceActive && state?.state === 'connecting'));
			mute.hidden = !ownsVoice || state?.state !== 'connected';
			mute.label = state?.muted
				? localize({ bundle: 'ash', key: 'voiceInputMode.unmute' }, 'Unmute microphone')
				: localize({ bundle: 'ash', key: 'voiceInputMode.mute' }, 'Mute microphone');
			mute.checked = state?.muted === true;
			mute.enabled = ownsVoice && state?.state === 'connected';
			if (this.modes.handsFree.read(reader)) {
				mute.domNode.removeAttribute('aria-description');
			} else {
				mute.domNode.setAttribute('aria-description', localize({ bundle: 'ash', key: 'voiceInputMode.pushToTalk' }, 'Push to talk is active. Hold the Voice: Push to Talk shortcut to speak.'));
			}
			dictationHover.update(dictation.label);
			powerHover.update(power.label);
			muteHover.update(mute.label);
			this.setTabbable(this.tabbable);
			if (mute.hidden && mute.hasFocus()) {
				power.focus();
			}
		}));
		this._register(dictation.onDidClick(() => {
			this.modes.setSelectedMode('dictation');
			if (this.options?.toggleDictation) {
				this.options.toggleDictation();
			} else {
				void this.commands.executeCommand('workbench.action.chat.toggleSpeechToText');
			}
		}));
		this._register(power.onDidClick(() => {
			this.modes.setSelectedMode('voice');
			void this.runActionWithContext();
		}));
		this._register(mute.onDidClick(() => {
			if (!mute.hidden && mute.enabled) {
				void this.runActionWithContext({
					id: AGENTS_VOICE_TOGGLE_MUTE_COMMAND_ID, label: mute.label, tooltip: mute.label, enabled: true,
					run: () => this.commands.executeCommand(AGENTS_VOICE_TOGGLE_MUTE_COMMAND_ID),
				});
			}
		}));
		this._register(addMicButtonContextMenuListener(dictation.domNode, () =>
			getDictationContextMenuActions(this.commands, this.configuration, this.keybindings, 'workbench.action.chat.toggleSpeechToText'), this.contextMenus));
		this._register(addDisposableListener(container, 'keydown', event => {
			if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
				return;
			}
			const available = this.buttons.filter(button => !button.hidden && button.enabled);
			const current = available.findIndex(button => button.hasFocus());
			const next = available[current + (event.key === 'ArrowRight' ? 1 : -1)];
			if (!next) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			for (const button of available) {
				button.domNode.tabIndex = button === next && this.tabbable ? 0 : -1;
			}
			next.focus();
		}));
	}

	public override setTabbable(tabbable: boolean): void {
		this.tabbable = tabbable;
		const available = this.buttons.filter(button => !button.hidden && button.enabled);
		const selected = available.find(button => button.hasFocus()) ?? available.find(button => button.domNode.dataset.selected === 'true') ?? available[0];
		for (const button of this.buttons) {
			button.domNode.tabIndex = tabbable && button === selected ? 0 : -1;
		}
	}

	public override focus(): void {
		(this.buttons.find(button => button.domNode.tabIndex === 0) ?? this.buttons.find(button => !button.hidden && button.enabled))?.focus();
	}
}

export function isVoiceInputModeAvailable(service: IVoiceInputModeService): VoiceInputMode | 'both' | undefined {
	if (service.voiceAvailable.get()) {
		return service.dictationAvailable.get() ? 'both' : 'voice';
	}
	return service.dictationAvailable.get() ? 'dictation' : undefined;
}
