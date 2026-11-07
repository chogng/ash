import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IAgentVoiceService } from '../../../../platform/agentHost/common/agentService.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import {
	AGENTS_VOICE_CONNECTED, AGENTS_VOICE_CONNECTING, AGENTS_VOICE_LISTENING, AGENTS_VOICE_MUTED,
	AGENTS_VOICE_PUSH_TO_TALK, AGENTS_VOICE_TOGGLE_MUTE_COMMAND_ID, AgentsVoiceSettingId, IAgentsVoiceWindowService,
} from '../common/agentsVoice.js';
import { AgentsVoiceWindowService } from './agentsVoiceWindowService.js';
import { IVoiceModeOnboardingService, VoiceModeOnboardingService } from './voiceModeOnboarding.js';
import { ChatContextKeys } from '../../chat/common/actions/chatContextKeys.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

registerSingleton(IAgentsVoiceWindowService, AgentsVoiceWindowService, InstantiationType.Delayed);
registerSingleton(IVoiceModeOnboardingService, VoiceModeOnboardingService, InstantiationType.Delayed);

const voiceModels = [{ value: 'gpt-live-1', label: 'GPT-Live 1' }] as const;
Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AgentsVoiceSettingId.Model, defaultValue: voiceModels[0].value, scope: ConfigurationScope.APPLICATION,
	schema: { type: 'string', enum: voiceModels.map(model => model.value) },
	parse(value) {
		const model = voiceModels.find(model => model.value === value);
		if (model) return model.value;
		throw new TypeError(localize('agentsVoice.model.invalid', 'Choose a supported voice model.'));
	},
	setting: {
		valueType: 'select',
		get title() { return localize('agentsVoice.model.title', 'Voice model'); },
		get description() { return localize('agentsVoice.model.description', 'Choose the model used by the voice conversation button. You can choose a voice when starting a conversation.'); },
		options: voiceModels,
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AgentsVoiceSettingId.ShowButton, defaultValue: true, scope: ConfigurationScope.WINDOW,
	parse: value => {
		if (typeof value !== 'boolean') {
			throw new TypeError(localize({ bundle: 'ash', key: 'voiceInputMode.showButtonInvalid' }, 'Show voice button must be boolean.'));
		}
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize({ bundle: 'ash', key: 'voiceInputMode.showButton' }, 'Show voice conversation button'); },
		get description() { return localize({ bundle: 'ash', key: 'voiceInputMode.showButtonDescription' }, 'Show the voice conversation control in Chat inputs.'); },
	},
});

registerAction2(class ShowVoiceIntroduction extends Action2 {
	constructor() {
		super({
			id: 'agentsVoice.showIntroduction',
			title: localize2('agentsVoice.command.introduction', 'Voice: Show Introduction'),
			f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true),
		});
	}
	run(accessor: ServicesAccessor): void {
		if (!accessor.get(IConfigurationService).getValue<boolean>(ChatAIDisabledSettingId)) {
			accessor.get(IVoiceModeOnboardingService).show();
		}
	}
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.AgentsVoice, defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') throw new TypeError(localize('agentsVoice.verbosity.invalid', 'Voice accessibility verbosity must be boolean.')); return value; },
	setting: {
		valueType: 'boolean',
		get title() { return localize('agentsVoice.verbosity.title', 'Voice conversation accessibility help'); },
		get description() { return localize('agentsVoice.verbosity.description', 'Announce how to access help when the voice controls receive focus.'); },
	},
});

registerWorkbenchContribution('workbench.contrib.agentsVoice', WorkbenchPhase.BlockRestore, accessor => {
	const lifetime = new DisposableStore();
	const context = accessor.get(IContextKeyService);
	const connected = AGENTS_VOICE_CONNECTED.bindTo(context);
	const connecting = AGENTS_VOICE_CONNECTING.bindTo(context);
	const listening = AGENTS_VOICE_LISTENING.bindTo(context);
	const muted = AGENTS_VOICE_MUTED.bindTo(context);
	const pushToTalk = AGENTS_VOICE_PUSH_TO_TALK.bindTo(context);
	lifetime.add(toDisposable(() => {
		connected.reset();
		connecting.reset();
		listening.reset();
		muted.reset();
		pushToTalk.reset();
	}));
	const voice = accessor.get(IAgentVoiceService);
	const update = () => {
		connected.set(voice?.state?.state === 'connected');
		connecting.set(voice?.state?.state === 'connecting');
		listening.set(voice?.state?.state === 'connected' && voice.state.listening);
		muted.set(voice?.state?.state === 'connected' && voice.state.muted);
		pushToTalk.set(voice?.state?.inputMode === 'pushToTalk' && !voice.state.muted);
	};
	if (voice) lifetime.add(voice.onDidChange(update));
	update();
	return lifetime;
});

registerAction2(class ToggleVoiceMute extends Action2 {
	constructor() { super({ id: AGENTS_VOICE_TOGGLE_MUTE_COMMAND_ID, title: localize2('agentsVoice.command.mute', 'Voice: Toggle Microphone Mute'), f1: true, precondition: AGENTS_VOICE_CONNECTED.isEqualTo(true) }); }
	async run(accessor: ServicesAccessor): Promise<void> { const voice = accessor.get(IAgentVoiceService); if (voice?.state?.state === 'connected') await voice.setMuted(!voice.state.muted); }
});

registerAction2(class PushToTalk extends Action2 {
	constructor() {
		super({
			id: 'agentsVoice.pushToTalk', title: localize2('agentsVoice.command.ptt', 'Voice: Push to Talk'),
			precondition: ContextKeyExpr.and(AGENTS_VOICE_CONNECTED.isEqualTo(true), AGENTS_VOICE_PUSH_TO_TALK.isEqualTo(true)),
			keybinding: { primary: Keybinding.single(logicalKey(' ', { primaryKey: true, shiftKey: true })) }
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const release = accessor.get(IKeybindingService).enableKeybindingHoldMode(this.desc.id);
		const voice = accessor.get(IAgentVoiceService);
		if (!release || !voice) return;
		const id = generateUuid();
		// Register release before awaiting the receipt: a quick tap must still close a late hold.
		try { await Promise.all([voice.pttDown(id), release.then(() => voice.pttUp(id))]); } finally { await voice.pttUp(id); }
	}
});

registerAction2(class OpenVoiceWindow extends Action2 {
	constructor() { super({ id: '_agentsVoice.openWindow', title: localize2('agentsVoice.command.window', 'Voice: Open Conversation Window'), f1: true }); }
	run(accessor: ServicesAccessor): Promise<void> { return accessor.get(IAgentsVoiceWindowService).openWindow(); }
});

registerAction2(class DisconnectVoice extends Action2 {
	constructor() {
		super({
			id: 'agentsVoice.disconnect', title: localize2('agentsVoice.command.disconnect', 'Voice: Disconnect'), f1: true,
			precondition: ContextKeyExpr.or(AGENTS_VOICE_CONNECTED.isEqualTo(true), AGENTS_VOICE_CONNECTING.isEqualTo(true)),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> { await accessor.get(IAgentVoiceService)?.stop(); }
});
