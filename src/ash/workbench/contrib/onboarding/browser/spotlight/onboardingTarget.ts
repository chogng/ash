import { Emitter, type Event } from '../../../../../base/common/event.js';
import { type IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';

export type OnboardingTargetProvider = (scope: string | undefined) => HTMLElement | undefined;

class OnboardingTargetRegistry {
	private readonly providers = new Map<string, Set<OnboardingTargetProvider>>();
	private readonly changeEmitter = new Emitter<void>();
	public readonly onDidChange: Event<void> = this.changeEmitter.event;

	public register(id: string, provider: OnboardingTargetProvider): IDisposable {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
			throw new TypeError(`Invalid onboarding target: ${id}`);
		}
		const providers = this.providers.get(id) ?? new Set<OnboardingTargetProvider>();
		if (providers.has(provider)) throw new TypeError(`Duplicate onboarding target provider: ${id}`);
		providers.add(provider);
		this.providers.set(id, providers);
		this.changeEmitter.fire();
		return toDisposable(() => {
			providers.delete(provider);
			if (providers.size === 0) this.providers.delete(id);
			this.changeEmitter.fire();
		});
	}

	public resolve(id: string, scope: string | undefined): HTMLElement | undefined {
		const matches = [...this.providers.get(id) ?? []]
			.map(provider => provider(scope))
			.filter((element): element is HTMLElement => !!element?.isConnected);
		return matches.length === 1 ? matches[0] : undefined;
	}
}

export const onboardingTargetRegistry = new OnboardingTargetRegistry();

export function registerOnboardingTargetProvider(id: string, provider: OnboardingTargetProvider): IDisposable {
	return onboardingTargetRegistry.register(id, provider);
}
