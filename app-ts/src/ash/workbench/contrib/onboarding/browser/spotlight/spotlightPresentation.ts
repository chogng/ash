import { addDisposableListener, getWindow } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import type { IOnboardingStep, OnboardingOutcome } from '../../common/onboardingScenario.js';
import { onboardingTargetRegistry } from './onboardingTarget.js';
import '../media/spotlight.css';

export class SpotlightPresentation {
	constructor(private readonly container: HTMLElement) {}

	public async show(steps: readonly IOnboardingStep[], token: CancellationToken, scope?: string): Promise<OnboardingOutcome> {
		if (steps.length === 0) return 'unavailable';
		const previousFocus = this.container.ownerDocument.activeElement;
		try {
			for (let index = 0; index < steps.length; index += 1) {
				if (token.isCancellationRequested) return 'cancelled';
				const step = steps[index]!;
				const target = onboardingTargetRegistry.resolve(step.target, scope);
				if (!target || !this.container.contains(target)) return 'unavailable';
				const result = await this.showStep(step, target, index, steps.length, token);
				if (result !== 'completed') return result;
			}
			return 'completed';
		} finally {
			if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
		}
	}

	private showStep(step: IOnboardingStep, target: HTMLElement, index: number, total: number, token: CancellationToken): Promise<OnboardingOutcome> {
		return new Promise<OnboardingOutcome>(resolve => {
			const resources = new DisposableStore();
			let settled = false;
			const finish = (outcome: OnboardingOutcome): void => {
				if (settled) return;
				settled = true;
				resources.dispose();
				resolve(outcome);
			};
			const document = this.container.ownerDocument;
			const root = document.createElement('div');
			root.className = 'ash-onboarding-spotlight';
			const frame = document.createElement('div');
			frame.className = 'ash-onboarding-spotlight-frame';
			frame.setAttribute('aria-hidden', 'true');
			const card = document.createElement('section');
			card.className = 'ash-onboarding-spotlight-card';
			card.setAttribute('role', 'dialog');
			card.setAttribute('aria-modal', 'false');
			const heading = document.createElement('h2');
			heading.id = `ash-onboarding-title-${index}`;
			heading.textContent = step.title;
			card.setAttribute('aria-labelledby', heading.id);
			const description = document.createElement('p');
			description.textContent = step.description;
			const help = document.createElement('p');
			help.hidden = true;
			help.textContent = localize('onboarding.help', 'Use Tab to reach Next or Dismiss. Press Escape to close this guide.');
			const progress = document.createElement('p');
			progress.className = 'ash-onboarding-spotlight-progress';
			progress.textContent = localize('onboarding.stepProgress', 'Step {0} of {1}', index + 1, total);
			const actions = document.createElement('div');
			actions.className = 'ash-onboarding-spotlight-actions';
			card.append(heading, description, help, progress, actions);
			root.append(frame, card);
			this.container.append(root);
			resources.add(toDisposable(() => root.remove()));
			const dismiss = resources.add(new Button(actions, {
				label: localize('onboarding.dismiss', 'Dismiss'),
				presentation: 'secondary',
				onClick: () => finish('dismissed'),
			}));
			const next = resources.add(new Button(actions, {
				label: index === total - 1 ? localize('onboarding.done', 'Done') : localize('onboarding.next', 'Next'),
				presentation: 'primary',
				onClick: () => finish('completed'),
			}));
			const targetWindow = getWindow(this.container);
			const position = (): void => {
				if (!target.isConnected) {
					finish('unavailable');
					return;
				}
				const bounds = target.getBoundingClientRect();
				const host = this.container.getBoundingClientRect();
				frame.style.left = `${bounds.left - host.left}px`;
				frame.style.top = `${bounds.top - host.top}px`;
				frame.style.width = `${bounds.width}px`;
				frame.style.height = `${bounds.height}px`;
				const cardWidth = Math.min(360, host.width - 24);
				const left = Math.max(12, Math.min(bounds.left - host.left, host.width - cardWidth - 12));
				const below = bounds.bottom - host.top + 12;
				const above = bounds.top - host.top - card.offsetHeight - 12;
				card.style.left = `${left}px`;
				card.style.top = `${below + card.offsetHeight <= host.height ? below : Math.max(12, above)}px`;
			};
			resources.add(addDisposableListener(targetWindow, 'resize', position));
			resources.add(addDisposableListener(this.container, 'scroll', position, true));
			resources.add(addDisposableListener(card, 'keydown', event => {
				if (event.key === 'Escape') {
					event.preventDefault();
					finish('dismissed');
				} else if (event.key === 'F1') {
					event.preventDefault();
					help.hidden = false;
				}
			}));
			if (step.advanceOnTargetClick) resources.add(addDisposableListener(target, 'click', () => finish('completed')));
			resources.add(token.onCancellationRequested(() => finish('cancelled')));
			if (token.isCancellationRequested) {
				finish('cancelled');
				return;
			}
			target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
			position();
			if (!settled) (step.advanceOnTargetClick ? dismiss : next).focus();
		});
	}
}
