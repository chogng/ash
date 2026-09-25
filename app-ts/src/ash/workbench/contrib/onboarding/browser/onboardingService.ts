import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { onboardingScenarioRegistry } from '../common/onboardingRegistry.js';
import type { IOnboardingStep, OnboardingOutcome } from '../common/onboardingScenario.js';
import { type IOnboardingScenarioService, ONBOARDING_ENABLED_CONFIG } from '../common/onboardingScenarioService.js';
import { SpotlightPresentation } from './spotlight/spotlightPresentation.js';
import { onboardingTargetRegistry } from './spotlight/onboardingTarget.js';

export class OnboardingScenarioService extends Disposable implements IOnboardingScenarioService {
	private readonly active = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly presentation: SpotlightPresentation;
	private pending: Promise<void> = Promise.resolve();
	private requestVersion = 0;
	private started = false;
	private evaluating = false;
	private rescheduleRequested = false;
	private readonly shownInWindow = new Set<string>();

	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@ILayoutService layout: ILayoutService,
		@IStorageService private readonly storage: IStorageService,
	) {
		super();
		this.presentation = new SpotlightPresentation(layout.mainContainer);
		this._register(toDisposable(() => this.active.value?.cancel()));
	}

	public start(): void {
		if (this.started) return;
		this.started = true;
		this._register(onboardingScenarioRegistry.onDidChange(() => this.schedule()));
		this._register(onboardingTargetRegistry.onDidChange(() => this.schedule()));
		this._register(this.contextKeys.onDidChangeContext(() => this.schedule()));
		this._register(this.configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ONBOARDING_ENABLED_CONFIG)) this.schedule();
		}));
		this.schedule();
	}

	public async run(id: string, token: CancellationToken = CancellationToken.None): Promise<OnboardingOutcome> {
		const scenario = onboardingScenarioRegistry.get(id);
		if (token.isCancellationRequested) return 'cancelled';
		if (!scenario || !this.contextKeys.contextMatchesRules(scenario.when)) return 'unavailable';
		if (scenario.isEligible && !await scenario.isEligible(token)) return token.isCancellationRequested ? 'cancelled' : 'unavailable';
		if (token.isCancellationRequested) return 'cancelled';
		return this.showSteps(scenario.steps, token);
	}

	public showSteps(steps: readonly IOnboardingStep[], token: CancellationToken, scope?: string): Promise<OnboardingOutcome> {
		const version = ++this.requestVersion;
		this.active.value?.cancel();
		const run = async (): Promise<OnboardingOutcome> => {
			if (this.isDisposed || version !== this.requestVersion || token.isCancellationRequested) return 'cancelled';
			const source = new CancellationTokenSource(token);
			this.active.value = source;
			try {
				return await this.presentation.show(steps, source.token, scope);
			} finally {
				if (this.active.value === source) this.active.clear();
			}
		};
		const result = this.pending.then(run, run);
		this.pending = result.then(() => undefined, () => undefined);
		return result;
	}

	public resetAll(): void {
		for (const scenario of onboardingScenarioRegistry.getScenarios()) {
			this.storage.remove(this.storageKey(scenario.id), StorageScope.PROFILE);
		}
		this.shownInWindow.clear();
		this.schedule();
	}

	private schedule(): void {
		if (!this.started || this.configuration.getValue<boolean>(ONBOARDING_ENABLED_CONFIG) !== true) return;
		if (this.evaluating) { this.rescheduleRequested = true; return; }
		this.evaluating = true;
		queueMicrotask(() => {
			void this.evaluate().catch(error => console.error('Unable to evaluate onboarding scenarios', error)).finally(() => {
				this.evaluating = false;
				if (this.rescheduleRequested) { this.rescheduleRequested = false; this.schedule(); }
			});
		});
	}

	private async evaluate(): Promise<void> {
		for (const scenario of onboardingScenarioRegistry.getScenarios()) {
			if (this.isDisposed || this.active.value) return;
			if (this.shownInWindow.has(scenario.id)) continue;
			if (this.storage.getBoolean(this.storageKey(scenario.id), StorageScope.PROFILE, false)) continue;
			if (!this.contextKeys.contextMatchesRules(scenario.when)) continue;
			if (scenario.isEligible && !await scenario.isEligible(CancellationToken.None)) continue;
			if (this.isDisposed || this.active.value || this.configuration.getValue<boolean>(ONBOARDING_ENABLED_CONFIG) !== true) return;
			const result = await this.showSteps(scenario.steps, CancellationToken.None);
			if (result === 'completed' || result === 'dismissed') {
				this.shownInWindow.add(scenario.id);
				this.storage.store(this.storageKey(scenario.id), true, StorageScope.PROFILE, StorageTarget.USER);
			}
			return;
		}
	}

	private storageKey(id: string): string {
		return `onboarding.shown.${id}`;
	}
}
