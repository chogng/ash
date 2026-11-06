import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import type { Constructor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase, type IWorkbenchContribution } from '../../../../../workbench/common/contributions.js';

type RemoteAgentHostContributions = typeof import('./remoteAgentHostContribution.js');

function registerRemoteContribution(id: string, select: (module: RemoteAgentHostContributions) => Constructor<IWorkbenchContribution>): void {
	registerWorkbenchContribution(id, WorkbenchPhase.AfterRestored, accessor => {
		const services = accessor.get(IInstantiationService);
		const lifetime = new DisposableStore();
		const ready = import('./remoteAgentHostContribution.js').then(module => {
			if (!lifetime.isDisposed) lifetime.add(services.createInstance(select(module)));
		}).catch(error => console.error(`Unable to create workbench contribution '${id}'`, error));
		return Object.assign(lifetime, { onWorkspaceRestored: () => ready });
	});
}

// Collect the declarations before startup. The implementations share an import
// so the SSH actions and the tunnel command they dispatch load together.
registerRemoteContribution('sessions.contrib.sshAgentHostContribution', module => module.SSHAgentHostContribution);
registerRemoteContribution('sessions.contrib.remoteAgentHostContribution', module => module.RemoteAgentHostContribution);
registerRemoteContribution('sessions.contrib.wslAgentHostContribution', module => module.WSLAgentHostContribution);
registerRemoteContribution('sessions.contrib.tunnelAgentHostContribution', module => module.TunnelAgentHostContribution);
