import assert from 'node:assert/strict';
import { test } from 'mocha';
import { getSingletonServiceDescriptors } from '../../../platform/instantiation/common/extensions.js';
import { ServiceContainer } from '../../../platform/instantiation/common/instantiation.js';
import { IRendererHostService, type IRendererHost } from '../../../platform/renderer/common/rendererHost.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../workbench/common/contributions.js';
import { IChatSessionNavigationService } from '../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import '../../browser/workbenchSessions.contribution.js';

test('Sessions registers its regular Workbench service and starts its catalog', async () => {
	let subscriptions = 0;
	let catalogLoads = 0;
	const api = {
		session: {
			async subscribeCatalog() { catalogLoads++; return { sessions: [] }; },
			async unsubscribeCatalog() {},
		},
		model: { async readModel() { return null; } },
		events: { subscribe() { subscriptions++; return { dispose() {} }; } },
	} as unknown as IRendererHost;
	using services = new ServiceContainer();
	services.registerInstance(IRendererHostService, api);
	for (const [id, descriptor] of getSingletonServiceDescriptors()) {
		if (id === ISessionsManagementService || id === IChatSessionNavigationService) {
			services.registerSingleton(id, () => services.createInstance(descriptor));
		}
	}
	const sessions = services.get(ISessionsManagementService);
	const navigation = services.get(IChatSessionNavigationService);
	assert.deepEqual(navigation.getConversations(), []);
	using contributions = WorkbenchContributionsRegistry.createHost(services);
	contributions.advance(WorkbenchPhase.BlockRestore);
	await sessions.initialize();
	assert.equal(subscriptions, 1);
	assert.equal(catalogLoads, 1);
});
