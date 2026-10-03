import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { type ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IDictationOnboardingService } from '../speechToText/dictationOnboarding.js';
import { IChatSpeechToTextService } from '../speechToText/chatSpeechToTextService.js';

registerAction2(class ShowDictationIntroductionAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.dictation.showIntroduction',
			title: localize2({ bundle: 'ash', key: 'dictation.showIntroduction' }, 'Dictation: Show introduction'),
			f1: true,
		});
	}
	public override run(accessor: ServicesAccessor): void { accessor.get(IDictationOnboardingService).show(); }
});
registerAction2(class CancelDictationAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.dictation.cancel',
			title: localize2({ bundle: 'ash', key: 'dictation.cancelCommand' }, 'Dictation: Cancel recording'),
			f1: true,
		});
	}
	public override run(accessor: ServicesAccessor): Promise<void> { return accessor.get(IChatSpeechToTextService).cancel(); }
});
