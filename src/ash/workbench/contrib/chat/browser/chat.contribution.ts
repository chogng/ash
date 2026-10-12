import { registerChatActions } from './actions/chatActions.js';
import { registerChatCodeBlockActions } from './actions/chatCodeblockActions.js';
import { PromptLanguageFeaturesProvider } from './promptSyntax/promptFileContributions.js';
import './chat.shared.contribution.js';
import './aiCustomization/aiCustomizationManagement.contribution.js';
import { registerHookActions } from './promptSyntax/hookActions.js';
import './actions/chatSpeechToTextActions.js';
import './chatEditing/chatEditingEditorActions.js';
import './chatEditing/chatEditingActions.js';
import { IChatEditingService } from '../common/editing/chatEditingService.js';
import { ChatEditingService } from './chatEditing/chatEditingServiceImpl.js';
import { ChatEditingEditorOverlay } from './chatEditing/chatEditingEditorOverlay.js';
import { registerSkillActions } from './promptSyntax/skillActions.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import "../common/widget/chatColors.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { ChatInputEditor } from "./widget/input/chatInputEditor.js";
import { ChatInputEditors } from "./widget/input/chatInputEditorRegistry.js";
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { DictationOnboardingService, IDictationOnboardingService } from './speechToText/dictationOnboarding.js';

registerSingleton(IChatEditingService, ChatEditingService, InstantiationType.Delayed);
registerWorkbenchContribution(ChatEditingEditorOverlay.ID, WorkbenchPhase.BlockRestore, accessor => accessor.get(IInstantiationService).createInstance(ChatEditingEditorOverlay));

registerSingleton(IDictationOnboardingService, DictationOnboardingService, InstantiationType.Delayed);
registerChatActions();
registerChatCodeBlockActions();
registerSkillActions();
registerHookActions();

registerWorkbenchContribution(PromptLanguageFeaturesProvider.ID, WorkbenchPhase.BlockStartup, accessor => accessor.get(IInstantiationService).createInstance(PromptLanguageFeaturesProvider));

registerWorkbenchContribution('workbench.contrib.chatInputEditor', WorkbenchPhase.BlockStartup, accessor => {
	const instantiationService = accessor.get(IInstantiationService);
	return ChatInputEditors.register({ id: 'stanza', create: options => instantiationService.createInstance(ChatInputEditor, options) });
});
