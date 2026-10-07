import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { DropOrPasteIntoCommands } from './commands.js';
import { DropOrPasteSchemaContribution, editorConfiguration } from './configurationSchema.js';

for (const definition of editorConfiguration) {
	Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration(definition);
}
registerWorkbenchContribution(DropOrPasteIntoCommands.ID, WorkbenchPhase.Eventually, accessor => accessor.get(IInstantiationService).createInstance(DropOrPasteIntoCommands));
registerWorkbenchContribution(DropOrPasteSchemaContribution.ID, WorkbenchPhase.BlockStartup, accessor => accessor.get(IInstantiationService).createInstance(DropOrPasteSchemaContribution));
