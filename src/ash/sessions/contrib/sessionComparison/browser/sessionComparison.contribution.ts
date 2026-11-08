import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IModelEvaluationTools } from '../../../services/appTools/browser/appTools.js';
import { COMPARE_AGENTS_TOOLS_ENABLED_SETTING, OPEN_SESSION_COMPARISON_COMMAND_ID } from '../../../services/sessions/common/sessionComparison.js';
import { ModelEvaluationToolContribution } from './modelEvaluationTools.js';
import { ISessionComparisonViewService, SessionComparisonViewService } from './sessionComparisonViewService.js';

registerSingleton(ISessionComparisonViewService, SessionComparisonViewService, InstantiationType.Delayed);
registerSingleton(IModelEvaluationTools, ModelEvaluationToolContribution, InstantiationType.Delayed);

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: COMPARE_AGENTS_TOOLS_ENABLED_SETTING,
	scope: ConfigurationScope.APPLICATION,
	defaultValue: false,
	parse: value => {
		if (typeof value !== 'boolean') throw new TypeError(localize('sessions.compare.tools.invalidSetting', 'The model evaluation tools setting must be a boolean.'));
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('sessions.compare.tools.settingTitle', 'Enable model evaluation tools'),
		description: localize('sessions.compare.tools.setting', 'Allow Agents to discover comparison models, read saved comparisons, and request approval to start model evaluations.'),
	},
});

CommandsRegistry.register(OPEN_SESSION_COMPARISON_COMMAND_ID, (accessor, comparisonId) => {
	if (typeof comparisonId === 'string') return accessor.get(ISessionComparisonViewService).open(comparisonId);
});
