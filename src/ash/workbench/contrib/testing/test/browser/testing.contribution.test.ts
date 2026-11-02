import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';
import { AppServerAvailableContext } from '../../../../common/contextkeys.js';
import { IAppServerApi, type AppServerConnectionState } from '../../../../../platform/agentHost/common/appServerApi.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ViewsRegistry, WorkbenchViewContainerId } from '../../../../common/views.js';
import { TestViewDescriptorService } from '../../../../test/browser/workbenchTestServices.js';
import { ITestingService } from '../../../../services/testing/common/testingService.js';
import { ITaskService } from '../../../tasks/common/taskService.js';
import { TESTING_VIEW_ID } from '../../common/testing.js';
import '../../browser/testing.contribution.js';

ensureNoDisposablesAreLeakedInTestSuite();

function appServer(state: () => AppServerConnectionState): IAppServerApi {
	return { isAvailable: true, connectionGeneration: 1, getConnectionState: async () => state(), onConnectionState: Event.None, getSlashCommands: async () => [] };
}

test('Testing navigation follows capability in the production contribution and releases its context', async () => {
	using services = new InstantiationService();
	using contextKeys = new ContextKeyService();
	AppServerAvailableContext.bindTo(contextKeys).set(true);
	using changes = new Emitter<void>();
	const testing = { hasTestCapability: false, onDidChangeTestCapability: changes.event };
	let refreshes = 0;
	services.registerInstance(IContextKeyService, contextKeys);
	services.registerInstance(IAppServerApi, appServer(() => 'ready'));
	services.registerInstance(ITestingService, testing as ITestingService);
	services.registerInstance(ITaskService, { getWorkspaceTasks: async () => { refreshes++; return []; } } as unknown as ITaskService);
	using descriptors = new TestViewDescriptorService({ registry: ViewsRegistry }, contextKeys);
	const model = descriptors.getViewContainerModel(WorkbenchViewContainerId.Testing);
	assert.deepEqual(model.activeViewDescriptors, []);
	assert.equal(model.viewContainer.hideIfEmpty, true);
	assert.equal(model.viewContainer.icon, Lxicon.beaker);

	using host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.testing']);
	host.advance(WorkbenchPhase.AfterRestored);
	await Promise.resolve();
	assert.equal(refreshes, 1, 'initial startup detects tasks without opening the Testing pane');
	testing.hasTestCapability = true;
	changes.fire();
	assert.deepEqual(model.visibleViewDescriptors.map(view => view.id), [TESTING_VIEW_ID]);
	testing.hasTestCapability = false;
	changes.fire();
	assert.deepEqual(model.activeViewDescriptors, []);
	await host.workspaceRestored();
	assert.equal(refreshes, 2, 'workspace switches refresh the capability source');
	testing.hasTestCapability = true;
	changes.fire();
	host.dispose();
	assert.deepEqual(model.activeViewDescriptors, []);
	changes.fire();
	assert.deepEqual(model.activeViewDescriptors, [], 'disposed windows no longer project capability changes');
});

test('Testing startup and workspace restoration do not read backend tasks in a disconnected host', async () => {
	using services = new InstantiationService();
	using contextKeys = new ContextKeyService();
	using changes = new Emitter<void>();
	// Desktop advertises server-backed features even when launched without its backend.
	AppServerAvailableContext.bindTo(contextKeys).set(true);
	let state: AppServerConnectionState = 'stopped';
	let refreshes = 0;
	services.registerInstance(IContextKeyService, contextKeys);
	services.registerInstance(IAppServerApi, appServer(() => state));
	services.registerInstance(ITestingService, { hasTestCapability: false, onDidChangeTestCapability: changes.event } as ITestingService);
	services.registerInstance(ITaskService, { getWorkspaceTasks: async () => { refreshes++; return []; } } as unknown as ITaskService);
	using host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.testing']);
	host.advance(WorkbenchPhase.AfterRestored);
	await Promise.resolve();
	assert.equal(refreshes, 0, 'UI-only startup must not request workspace metadata from the disconnected API');
	await host.workspaceRestored();
	assert.equal(refreshes, 0, 'restoring a disconnected workspace must also stay quiet');
	state = 'ready';
	await host.workspaceRestored();
	assert.equal(refreshes, 1, 'a host with an App Server still detects workspace tasks');
});
