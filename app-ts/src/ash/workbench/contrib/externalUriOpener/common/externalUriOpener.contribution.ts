import { Disposable } from '../../../../base/common/lifecycle.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { externalUriOpenersConfigurationNode } from './configuration.js';
import { ExternalUriOpenerService, IExternalUriOpenerService } from './externalUriOpenerService.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration(externalUriOpenersConfigurationNode);
registerSingleton(IExternalUriOpenerService, ExternalUriOpenerService, InstantiationType.Eager);

// The service container owns disposal. Startup must resolve it before the first link
// activation because providers need not have registered before a configured URL opens.
registerWorkbenchContribution('workbench.contrib.externalUriOpener', WorkbenchPhase.BlockStartup, accessor => {
	accessor.get(IExternalUriOpenerService);
	return Disposable.None;
});
