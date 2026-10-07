import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { ContextKeyExpression } from '../../../../platform/contextkey/common/contextkey.js';

export interface IOnboardingStep {
	readonly target: string;
	readonly title: string;
	readonly description: string;
	readonly advanceOnTargetClick?: boolean;
}

export interface IOnboardingScenario {
	readonly id: string;
	readonly when?: ContextKeyExpression;
	readonly steps: readonly IOnboardingStep[];
	readonly isEligible?: (token: CancellationToken) => boolean | Promise<boolean>;
}

export type OnboardingOutcome = 'completed' | 'dismissed' | 'unavailable' | 'cancelled';
