import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { WorkbenchConfigurationService, type WorkbenchConfigurationServiceOptions } from '../../../../workbench/services/configuration/browser/configurationService.js';

/** Resolves Agents Window defaults without changing the shared settings resource. */
export class ConfigurationService extends WorkbenchConfigurationService {
	constructor(options: Omit<WorkbenchConfigurationServiceOptions, 'defaults' | 'readOnlyKeys'> = {}) {
		const registry = options.registry ?? Registry.as<IConfigurationRegistry>(Extensions.Configuration);
		const defaults = new Map<string, unknown>();
		const readOnlyKeys = new Set<string>();
		for (const configuration of registry.getRegisteredConfigurations()) {
			if (!configuration.agentsWindow) continue;
			defaults.set(configuration.key, configuration.agentsWindow.default);
			if (configuration.agentsWindow.readOnly) readOnlyKeys.add(configuration.key);
		}
		super({ ...options, registry, defaults, readOnlyKeys });
	}
}
