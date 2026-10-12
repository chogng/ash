import { registerChatActions } from './actions/chatActions.js';
import { registerChatCodeBlockActions } from './actions/chatCodeblockActions.js';
import { combinedDisposable } from '../../../../base/common/lifecycle.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { PromptHeaderAutocompletion } from '../common/promptSyntax/languageProviders/promptHeaderAutocompletion.js';
import { PromptHoverProvider } from '../common/promptSyntax/languageProviders/promptHovers.js';
import './chat.shared.contribution.js';
import './aiCustomization/aiCustomizationManagement.contribution.js';
import { registerHookActions } from './promptSyntax/hookActions.js';
import './actions/chatSpeechToTextActions.js';
import './chatEditing/chatEditingEditorActions.js';
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
import { ChatSpeechToTextService, IChatSpeechToTextService } from './speechToText/chatSpeechToTextService.js';
import { DictationOnboardingService, IDictationOnboardingService } from './speechToText/dictationOnboarding.js';

registerSingleton(IChatEditingService, ChatEditingService, InstantiationType.Delayed);
registerWorkbenchContribution(ChatEditingEditorOverlay.ID, WorkbenchPhase.BlockRestore, accessor => accessor.get(IInstantiationService).createInstance(ChatEditingEditorOverlay));

registerSingleton(IChatSpeechToTextService, ChatSpeechToTextService, InstantiationType.Delayed);
registerSingleton(IDictationOnboardingService, DictationOnboardingService, InstantiationType.Delayed);
registerChatActions();
registerChatCodeBlockActions();
registerSkillActions();
registerHookActions();

registerWorkbenchContribution('workbench.contrib.chatPromptSyntax', WorkbenchPhase.BlockStartup, accessor => {
	const features = accessor.get(ILanguageFeaturesService);
	return combinedDisposable(
		features.completionProvider.register(new PromptHeaderAutocompletion()),
		features.hoverProvider.register(['markdown'], new PromptHoverProvider()),
	);
});

registerWorkbenchContribution('workbench.contrib.chatInputEditor', WorkbenchPhase.BlockStartup, accessor => {
	const instantiationService = accessor.get(IInstantiationService);
	return ChatInputEditors.register({ id: 'stanza', create: options => instantiationService.createInstance(ChatInputEditor, options) });
});
