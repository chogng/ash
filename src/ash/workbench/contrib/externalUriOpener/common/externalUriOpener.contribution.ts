import { Disposable } from '../../../../base/common/lifecycle.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { externalUriOpenersConfigurationNode } from './configuration.js';
import { ExternalUriOpenerService, IExternalUriOpenerService } from './externalUriOpenerService.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration(externalUriOpenersConfigurationNode);
registerSingleton(IExternalUriOpenerService, ExternalUriOpenerService, InstantiationType.Eager);

// Preferences needs the editor service assembled during restoration. The container
// owns disposal; this registration installs dispatch before the Workbench is ready.
registerWorkbenchContribution('workbench.contrib.externalUriOpener', WorkbenchPhase.BlockRestore, accessor => {
	accessor.get(IExternalUriOpenerService);
	return Disposable.None;
});
