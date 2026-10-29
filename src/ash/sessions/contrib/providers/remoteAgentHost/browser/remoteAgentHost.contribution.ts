import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { SSHAgentHostContribution } from './sshAgentHost.contribution.js';

// The Desktop entrypoint admits this window-owned scope after the base Sessions services restore.
registerWorkbenchContribution(SSHAgentHostContribution.ID, WorkbenchPhase.AfterRestored, accessor =>
	accessor.get(IInstantiationService).createInstance(SSHAgentHostContribution),
);
