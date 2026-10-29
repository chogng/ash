import { localize } from '../../../../nls.js';
import { ShowAllCommandsCommandId } from '../../quickaccess.js';
import { registerOnboardingTryout } from '../../../contrib/onboarding/common/onboardingTryout.js';

registerOnboardingTryout({
	id: 'workbench.commandCenter.open',
	get title() { return localize('onboarding.commandCenter.tryoutTitle', 'Open Search commands'); },
	get description() { return localize('onboarding.commandCenter.tryoutDescription', 'Open the command search. No command runs until you choose one.'); },
	presentation: { kind: 'command', commandId: ShowAllCommandsCommandId },
});
