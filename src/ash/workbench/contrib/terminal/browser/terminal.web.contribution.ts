import { registerWorkbenchServiceContribution } from '../../../browser/workbenchServiceContributions.js';
import { ITerminalProfileResolverService, ITerminalProfileService } from '../common/terminal.js';
import { ITerminalProcessService } from '../../../../platform/terminal/common/terminal.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IConfigurationResolverService } from '../../../services/configurationResolver/common/configurationResolver.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEnvironmentVariableService } from '../common/environmentVariable.js';
import { BrowserTerminalProfileResolverService } from './terminalProfileResolverService.js';
import { registerTerminalBackend } from './agentHostTerminalService.js';
import { RemoteTerminalBackend } from './remoteTerminalBackend.js';

// Both local server folders and SSH folders are hosted outside the Web renderer.
registerTerminalBackend('local', RemoteTerminalBackend);
registerTerminalBackend('remote', RemoteTerminalBackend);

registerWorkbenchServiceContribution({
	service: ITerminalProfileResolverService,
	dependencies: [
		ITerminalProfileService,
		ITerminalProcessService,
		IConfigurationService,
		IConfigurationResolverService,
		IWorkspaceContextService,
		IEnvironmentVariableService,
	],
	install: context => context.register(context.container.createInstance(BrowserTerminalProfileResolverService)),
});
