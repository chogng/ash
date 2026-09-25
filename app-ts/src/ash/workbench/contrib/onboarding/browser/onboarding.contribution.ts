import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { localize, localize2 } from '../../../../nls.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IOnboardingScenarioService, ONBOARDING_ENABLED_CONFIG } from '../common/onboardingScenarioService.js';
import { OnboardingScenarioService } from './onboardingService.js';
import './onboardingTryout.contribution.js';

registerSingleton(IOnboardingScenarioService, OnboardingScenarioService, InstantiationType.Delayed);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	key: ONBOARDING_ENABLED_CONFIG,
	defaultValue: true,
	parse: value => typeof value === 'boolean' ? value : true,
	setting: {
		valueType: 'boolean',
		title: localize('onboarding.enabled.title', 'Onboarding guides'),
		description: localize('onboarding.enabled.description', 'Show eligible feature guides automatically. Manually started guides remain available.'),
	},
});

registerWorkbenchContribution('workbench.contrib.onboarding', WorkbenchPhase.AfterRestored, accessor => {
	accessor.get(IOnboardingScenarioService).start();
	return { dispose(): void {}, [Symbol.dispose](): void {} };
});

registerAction2(class RunOnboardingScenarioAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.onboarding.run', title: localize2('onboarding.run', 'Run Onboarding Guide') });
	}

	public run(accessor: ServicesAccessor, id: unknown): Promise<unknown> | undefined {
		return typeof id === 'string' ? accessor.get(IOnboardingScenarioService).run(id) : undefined;
	}
});

registerAction2(class ResetOnboardingShownStateAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.onboarding.resetShownState', title: localize2('onboarding.resetShownState', 'Reset Onboarding Shown State'), f1: true });
	}

	public run(accessor: ServicesAccessor): void {
		accessor.get(IOnboardingScenarioService).resetAll();
	}
});
