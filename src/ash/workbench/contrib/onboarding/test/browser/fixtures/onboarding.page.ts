import '../../../../../../base/browser/ui/button/button.css';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { registerOnboardingTargetProvider } from '../../../browser/spotlight/onboardingTarget.js';
import { SpotlightPresentation } from '../../../browser/spotlight/spotlightPresentation.js';

declare global {
	interface Window {
		ashOnboardingIntegration: {
			show(scope: string): void;
			readonly result: string | undefined;
		};
	}
}

const container = document.querySelector<HTMLElement>('main')!;
const first = document.querySelector<HTMLElement>('#first')!;
const second = document.querySelector<HTMLElement>('#second')!;
registerOnboardingTargetProvider('test.onboarding.target', scope => scope === 'second' ? second : first);
const presentation = new SpotlightPresentation(container);
let result: string | undefined;
window.ashOnboardingIntegration = {
	show(scope: string): void {
		result = undefined;
		void presentation.show([{ target: 'test.onboarding.target', title: 'Find the target', description: 'Continue with this control.' }], CancellationToken.None, scope).then(outcome => { result = outcome; });
	},
	get result(): string | undefined { return result; },
};
