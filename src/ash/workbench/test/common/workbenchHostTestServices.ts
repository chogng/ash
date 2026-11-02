import { URI } from '../../../base/common/uri.js';
import { IAgentConnection } from '../../../platform/agentHost/common/agentService.js';
import { IApprovalEnvironmentService } from '../../../platform/approvalEnvironment/common/approvalEnvironmentService.js';
import { IAppServerApi } from '../../../platform/agentHost/common/appServerApi.js';
import { IRemoteAgentHostService, NullRemoteAgentHostService } from '../../../platform/agentHost/common/remoteAgentHostService.js';
import type { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import type { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { BrowserPathService } from '../../services/path/browser/pathService.js';
import { ServiceCollection } from '../../../platform/instantiation/common/serviceCollection.js';
import { ISymphonyBackendService } from '../../../platform/symphony/common/symphonyService.js';
import { createDisconnectedRendererApi, type IWorkbenchHost } from '../../browser/rendererApi.js';
import { IWorkbenchEnvironmentService } from '../../services/environment/common/environmentService.js';

/** Existing host fixtures supply domain registrations without introducing a test-only host service. */
export function testAppServerApi(host: Partial<IWorkbenchHost>): IAppServerApi {
	return host.appServer ?? createDisconnectedRendererApi().appServer;
}

export function testWorkbenchHostServices(host: Partial<IWorkbenchHost>): ServiceCollection {
	return new ServiceCollection(
		[IAgentConnection, host as IAgentConnection],
		[IApprovalEnvironmentService, host.approvalEnvironment],
		[IAppServerApi, testAppServerApi(host)],
		[IRemoteAgentHostService, host.agentHosts ?? new NullRemoteAgentHostService()],
		[ISymphonyBackendService, host.symphony],
		[IWorkbenchEnvironmentService, {
			isBuilt: false, webviewExternalEndpoint: '', argvResource: URI.from({ scheme: 'test', path: '/argv.json' }),
			userHome: host.localUserHome, userRoamingDataHome: host.userDataHome,
		}],
	);
}

export function registerTestWorkbenchHostServices(services: InstantiationService, host: Partial<IWorkbenchHost>): void {
	for (const [id, service] of testWorkbenchHostServices(host).entries()) {
		if (id === IWorkbenchEnvironmentService && services.has(IWorkbenchEnvironmentService)) {
			Object.assign(services.get(IWorkbenchEnvironmentService), {
				userHome: host.localUserHome, userRoamingDataHome: host.userDataHome,
			});
		} else {
			services.registerInstance(id, service);
		}
	}
}

export function createTestPathService(host: Partial<IWorkbenchHost>, workspace: IWorkspaceContextService): BrowserPathService {
	return new BrowserPathService(testAppServerApi(host), {
		isBuilt: false, webviewExternalEndpoint: '', argvResource: URI.from({ scheme: 'test', path: '/argv.json' }),
		userHome: host.localUserHome,
	}, workspace);
}
