import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IOnboardingStep, OnboardingOutcome } from './onboardingScenario.js';

export const ONBOARDING_ENABLED_CONFIG = 'onboarding.enabled';

export interface IOnboardingScenarioService {
	start(): void;
	run(id: string, token?: CancellationToken): Promise<OnboardingOutcome>;
	showSteps(steps: readonly IOnboardingStep[], token: CancellationToken, scope?: string): Promise<OnboardingOutcome>;
	resetAll(): void;
}

export const IOnboardingScenarioService = createServiceIdentifier<IOnboardingScenarioService>('onboardingScenarioService');
