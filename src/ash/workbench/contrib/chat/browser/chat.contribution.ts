import './actions/chatSpeechToTextActions.js';
import './chatEditing/chatEditing.contribution.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import "../common/widget/chatColors.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { ChatInputEditor } from "./widget/input/chatInputEditor.js";
import { ChatInputEditors } from "./widget/input/chatInputEditorRegistry.js";
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ChatSpeechToTextService, IChatSpeechToTextService } from './speechToText/chatSpeechToTextService.js';
import { DictationOnboardingService, IDictationOnboardingService } from './speechToText/dictationOnboarding.js';

registerSingleton(IChatSpeechToTextService, ChatSpeechToTextService, InstantiationType.Delayed);
registerSingleton(IDictationOnboardingService, DictationOnboardingService, InstantiationType.Delayed);

registerWorkbenchContribution('workbench.contrib.chatInputEditor', WorkbenchPhase.BlockStartup, accessor => {
	const instantiationService = accessor.get(IInstantiationService);
	return ChatInputEditors.register({ id: 'stanza', create: options => instantiationService.createInstance(ChatInputEditor, options) });
});
