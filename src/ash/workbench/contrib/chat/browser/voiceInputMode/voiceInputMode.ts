import { Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun, observableFromEvent, type IObservable } from '../../../../../base/common/observable.js';
import { IAgentVoiceService } from '../../../../../platform/agentHost/common/agentService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IChatSpeechToTextService, DictationSettingId } from '../speechToText/chatSpeechToTextService.js';
import { AgentsVoiceSettingId } from '../../../agentsVoice/common/agentsVoice.js';

export type VoiceInputMode = 'dictation' | 'voice';

export const CHAT_VOICE_INPUT_MODE = new RawContextKey<VoiceInputMode>('chatVoiceInputMode', 'voice');
export const IVoiceInputModeService = createDecorator<IVoiceInputModeService>('voiceInputModeService');

/** Input selection is profile UI state; recording and connection state stay with their services. */
export interface IVoiceInputModeService {
	readonly _serviceBrand: undefined;
	readonly selectedMode: IObservable<VoiceInputMode>;
	readonly voiceAvailable: IObservable<boolean>;
	readonly dictationAvailable: IObservable<boolean>;
	readonly handsFree: IObservable<boolean>;
	setSelectedMode(mode: VoiceInputMode): void;
}

const selectionKey = 'chat.voiceInputMode.selected';

export class VoiceInputModeService extends Disposable implements IVoiceInputModeService {
	public declare readonly _serviceBrand: undefined;
	public readonly selectedMode: IObservable<VoiceInputMode>;
	public readonly voiceAvailable: IObservable<boolean>;
	public readonly dictationAvailable: IObservable<boolean>;
	public readonly handsFree: IObservable<boolean>;

	constructor(
		@IStorageService private readonly storage: IStorageService,
		@IConfigurationService configuration: IConfigurationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IChatSpeechToTextService dictation: IChatSpeechToTextService,
		@IAgentVoiceService voice: IAgentVoiceService | undefined,
	) {
		super();
		this.selectedMode = observableFromEvent(this, storage.onDidChangeValue, () =>
			storage.get(selectionKey, StorageScope.PROFILE) === 'dictation' ? 'dictation' : 'voice');
		const enabled = (): boolean => configuration.getValue<boolean>(ChatAIDisabledSettingId) !== true;
		this.voiceAvailable = observableFromEvent(this, Event.any(configuration.onDidChangeConfiguration, voice?.onDidChange ?? Event.None), () =>
			enabled() && voice?.isAvailable === true && configuration.getValue<boolean>(AgentsVoiceSettingId.ShowButton) !== false);
		this.dictationAvailable = observableFromEvent(this, Event.any(configuration.onDidChangeConfiguration, dictation.onDidChangeState), () =>
			enabled() && dictation.isConfigured && configuration.getValue<boolean>(DictationSettingId.ShowButton) !== false);
		this.handsFree = observableFromEvent(this, voice?.onDidChange ?? Event.None, () => voice?.state?.inputMode !== 'pushToTalk');
		const selected = CHAT_VOICE_INPUT_MODE.bindTo(contextKeys);
		this._register(toDisposable(() => selected.reset()));
		this._register(autorun(reader => selected.set(this.selectedMode.read(reader))));
	}

	public setSelectedMode(mode: VoiceInputMode): void {
		this.storage.store(selectionKey, mode, StorageScope.PROFILE, StorageTarget.USER);
	}
}
