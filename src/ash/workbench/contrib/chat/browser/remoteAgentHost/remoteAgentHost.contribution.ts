import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../common/contributions.js';
import { RemoteAgentHostContribution } from './remoteAgentHostChatContribution.js';

registerWorkbenchContribution(RemoteAgentHostContribution.ID, WorkbenchPhase.BlockRestore,
	accessor => accessor.get(IInstantiationService).createInstance(RemoteAgentHostContribution));
