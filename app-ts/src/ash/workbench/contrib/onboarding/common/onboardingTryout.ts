import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { OnboardingOutcome, IOnboardingStep } from './onboardingScenario.js';

export const RUN_ONBOARDING_TRYOUT_COMMAND_ID = 'workbench.action.onboarding.tryFeature';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type OnboardingTryoutPresentation =
	| { readonly kind: 'command'; readonly commandId: string; readonly arguments?: readonly unknown[] }
	| { readonly kind: 'openView'; readonly viewId: string }
	| { readonly kind: 'guided'; readonly steps: readonly IOnboardingStep[]; readonly prepare?: (token: CancellationToken) => string | void | Promise<string | void> };

export interface IOnboardingTryout {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly presentation: OnboardingTryoutPresentation;
	readonly isAvailable?: (token: CancellationToken) => boolean | Promise<boolean>;
	readonly unavailableMessage?: string;
	readonly setup?: { readonly label: string; readonly commandId: string };
}

class OnboardingTryoutRegistry {
	private readonly entries = new Map<string, IOnboardingTryout>();
	private readonly changeEmitter = new Emitter<void>();
	public readonly onDidChange: Event<void> = this.changeEmitter.event;

	public register(tryout: IOnboardingTryout): IDisposable {
		if (!ID_PATTERN.test(tryout.id) || this.entries.has(tryout.id) || !tryout.title || !tryout.description) {
			throw new TypeError(`Invalid or duplicate onboarding tryout: ${tryout.id}`);
		}
		this.entries.set(tryout.id, tryout);
		this.changeEmitter.fire();
		return toDisposable(() => {
			if (this.entries.get(tryout.id) === tryout) {
				this.entries.delete(tryout.id);
				this.changeEmitter.fire();
			}
		});
	}

	public get(id: string): IOnboardingTryout | undefined {
		return this.entries.get(id);
	}

	public getTryouts(): readonly IOnboardingTryout[] {
		return [...this.entries.values()];
	}
}

export const onboardingTryoutRegistry = new OnboardingTryoutRegistry();

export function registerOnboardingTryout(tryout: IOnboardingTryout): IDisposable {
	return onboardingTryoutRegistry.register(tryout);
}

export function parseOnboardingTryoutArguments(args: readonly unknown[]): string | undefined {
	return args.length === 1 && typeof args[0] === 'string' && ID_PATTERN.test(args[0]) ? args[0] : undefined;
}

export function createOnboardingTryoutLink(id: string): string {
	if (!ID_PATTERN.test(id)) throw new TypeError(`Invalid onboarding tryout ID: ${id}`);
	return `ash://tryout/${encodeURIComponent(id)}`;
}

export function parseOnboardingTryoutLink(href: string): string | undefined {
	try {
		const url = new URL(href);
		if (url.protocol !== 'ash:' || url.hostname !== 'tryout' || url.username || url.password || url.port || url.search || url.hash || !/^\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(url.pathname)) return undefined;
		return url.pathname.slice(1);
	} catch {
		return undefined;
	}
}

export interface IOnboardingTryoutService {
	getTryouts(): readonly IOnboardingTryout[];
	run(id: string, token?: CancellationToken): Promise<OnboardingOutcome>;
	openLink(href: string, token?: CancellationToken): Promise<OnboardingOutcome>;
}

export const IOnboardingTryoutService = createServiceIdentifier<IOnboardingTryoutService>('onboardingTryoutService');
