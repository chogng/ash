import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize2 } from '../../../../nls.js';
import { IOnboardingTryoutService, parseOnboardingTryoutArguments, RUN_ONBOARDING_TRYOUT_COMMAND_ID } from '../common/onboardingTryout.js';
import { OnboardingTryoutService } from './onboardingTryoutService.js';

registerSingleton(IOnboardingTryoutService, OnboardingTryoutService, InstantiationType.Delayed);

registerAction2(class RunOnboardingTryoutAction extends Action2 {
	constructor() {
		super({ id: RUN_ONBOARDING_TRYOUT_COMMAND_ID, title: localize2('onboarding.tryout.run', 'Try Feature Example') });
	}

	public run(accessor: ServicesAccessor, ...args: readonly unknown[]): Promise<unknown> | undefined {
		const id = parseOnboardingTryoutArguments(args);
		return id ? accessor.get(IOnboardingTryoutService).run(id) : undefined;
	}
});
