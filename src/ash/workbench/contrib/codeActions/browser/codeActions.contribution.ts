import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { CodeActionsContribution, editorConfiguration, notebookEditorConfiguration } from './codeActionsContribution.js';

const configurationRegistry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
configurationRegistry.registerConfiguration(editorConfiguration);
configurationRegistry.registerConfiguration(notebookEditorConfiguration);
registerWorkbenchContribution(CodeActionsContribution.ID, WorkbenchPhase.Eventually, accessor => accessor.get(IInstantiationService).createInstance(CodeActionsContribution));
