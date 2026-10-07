import { Emitter, type Event } from '../../../../base/common/event.js';
import { type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IOnboardingScenario } from './onboardingScenario.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

class OnboardingScenarioRegistry {
	private readonly scenarios = new Map<string, IOnboardingScenario>();
	private readonly changeEmitter = new Emitter<void>();

	public readonly onDidChange: Event<void> = this.changeEmitter.event;

	public register(scenario: IOnboardingScenario): IDisposable {
		if (!ID_PATTERN.test(scenario.id) || scenario.steps.length === 0 || this.scenarios.has(scenario.id)) {
			throw new TypeError(`Invalid or duplicate onboarding scenario: ${scenario.id}`);
		}
		this.scenarios.set(scenario.id, scenario);
		this.changeEmitter.fire();
		return toDisposable(() => {
			if (this.scenarios.get(scenario.id) === scenario) {
				this.scenarios.delete(scenario.id);
				this.changeEmitter.fire();
			}
		});
	}

	public get(id: string): IOnboardingScenario | undefined {
		return this.scenarios.get(id);
	}

	public getScenarios(): readonly IOnboardingScenario[] {
		return [...this.scenarios.values()];
	}
}

export const onboardingScenarioRegistry = new OnboardingScenarioRegistry();

export function registerOnboardingScenario(scenario: IOnboardingScenario): IDisposable {
	return onboardingScenarioRegistry.register(scenario);
}
