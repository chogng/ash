import './localTerminalBackend.js';
import { registerRemoteContributions } from './terminalRemote.js';
import { ElectronTerminalProfileResolverService } from './terminalProfileResolverService.js';
import { registerWorkbenchServiceContribution } from '../../../browser/workbenchServiceContributions.js';
import { ITerminalProfileResolverService, ITerminalProfileService } from '../common/terminal.js';
import { ITerminalProcessService } from '../../../../platform/terminal/common/terminal.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IConfigurationResolverService } from '../../../services/configurationResolver/common/configurationResolver.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEnvironmentVariableService } from '../common/environmentVariable.js';

import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { TerminalNativeContribution } from './terminalNativeContribution.js';

registerWorkbenchContribution(TerminalNativeContribution.ID, WorkbenchPhase.BlockRestore, accessor => accessor.get(IInstantiationService).createInstance(TerminalNativeContribution));

registerRemoteContributions();

registerWorkbenchServiceContribution({
	service: ITerminalProfileResolverService,
	dependencies: [ITerminalProfileService, ITerminalProcessService, IConfigurationService, IConfigurationResolverService, IWorkspaceContextService, IEnvironmentVariableService],
	install: context => context.register(context.container.createInstance(ElectronTerminalProfileResolverService)),
});
