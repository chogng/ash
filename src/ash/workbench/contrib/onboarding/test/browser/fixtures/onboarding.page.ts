import '../../../../../../base/browser/ui/button/button.css';
import { CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { registerOnboardingTargetProvider } from '../../../browser/spotlight/onboardingTarget.js';
import { SpotlightPresentation } from '../../../browser/spotlight/spotlightPresentation.js';

declare global {
	interface Window {
		ashOnboardingIntegration: {
			show(scope: string): void;
			cancel(): void;
			readonly result: string | undefined;
		};
	}
}

const container = document.querySelector<HTMLElement>('main')!;
const first = document.querySelector<HTMLElement>('#first')!;
const second = document.querySelector<HTMLElement>('#second')!;
registerOnboardingTargetProvider('test.onboarding.target', scope => scope === 'second' ? second : first);
const presentation = new SpotlightPresentation(container);
let source: CancellationTokenSource | undefined;
let result: string | undefined;
window.ashOnboardingIntegration = {
	show(scope: string): void {
		result = undefined;
		const cancellation = new CancellationTokenSource();
		source = cancellation;
		void presentation.show([{ target: 'test.onboarding.target', title: 'Find the target', description: 'Continue with this control.' }], cancellation.token, scope).then(outcome => {
			cancellation.dispose();
			if (source !== cancellation) return;
			source = undefined;
			result = outcome;
		});
	},
	cancel(): void { source?.cancel(); },
	get result(): string | undefined { return result; },
};
