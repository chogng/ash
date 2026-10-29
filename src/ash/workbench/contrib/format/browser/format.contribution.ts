import { localize } from '../../../../nls.js';
import {
	ConfigurationScope,
	Extensions,
	type IConfigurationRegistry,
} from '../../../../platform/configuration/common/configurationRegistry.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { DefaultFormatter } from './formatActionsMultiple.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<string | null>({
	key: DefaultFormatter.configName,
	defaultValue: null,
	scope: ConfigurationScope.LANGUAGE_OVERRIDABLE,
	parse: value => {
		if (
			value !== null &&
			(typeof value !== 'string' || !value.trim() || value.length > 256 || /[\r\n\0]/u.test(value))
		) {
			throw new TypeError(
				localize(
					'format.default.invalid',
					'The default formatter must be a non-empty extension identifier or null.',
				),
			);
		}
		return value;
	},
	schema: {
		type: ['string', 'null'],
		default: null,
		get description() {
			return localize('format.default.description', 'The extension identifier used to format this language.');
		},
	},
});

registerWorkbenchContribution('workbench.contrib.defaultFormatter', WorkbenchPhase.BlockRestore, accessor =>
	accessor.get(IInstantiationService).createInstance(DefaultFormatter),
);
