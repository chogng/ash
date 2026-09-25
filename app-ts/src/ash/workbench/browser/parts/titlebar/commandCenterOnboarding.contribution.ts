import { localize } from '../../../../nls.js';
import { ShowAllCommandsCommandId } from '../../quickaccess.js';
import { registerOnboardingScenario } from '../../../contrib/onboarding/common/onboardingRegistry.js';
import { registerOnboardingTryout } from '../../../contrib/onboarding/common/onboardingTryout.js';

registerOnboardingScenario({
	id: 'workbench.commandCenter.firstRun',
	steps: [{
		target: 'workbench.commandCenter.button',
		get title() { return localize('onboarding.commandCenter.title', 'Find commands quickly'); },
		get description() { return localize('onboarding.commandCenter.description', 'Select Search commands to find an action by name. You can also use the keyboard shortcut shown in the menu.'); },
		advanceOnTargetClick: true,
	}],
});

registerOnboardingTryout({
	id: 'workbench.commandCenter.open',
	get title() { return localize('onboarding.commandCenter.tryoutTitle', 'Open Search commands'); },
	get description() { return localize('onboarding.commandCenter.tryoutDescription', 'Open the command search. No command runs until you choose one.'); },
	presentation: { kind: 'command', commandId: ShowAllCommandsCommandId },
});
