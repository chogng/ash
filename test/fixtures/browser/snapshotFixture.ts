import { ServiceCollection } from '../../../src/ash/platform/instantiation/common/serviceCollection.js';
import { IAdapterManager } from '../../../src/ash/workbench/contrib/debug/common/debug.js';
import { AdapterManager } from '../../../src/ash/workbench/contrib/debug/browser/debugAdapterManager.js';
import { IImageEditorService } from '../../../src/ash/workbench/services/imageEditor/common/imageEditorService.js';
import { createBuiltinExtensionFixture } from './builtinExtensionsFixture.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { IExtensionApi } from '../../../src/ash/platform/extensions/common/extensionApi.js';
import { IExtensionService } from '../../../src/ash/workbench/services/extensions/common/extensionService.js';
import { AppServerExtensionService } from '../../../src/ash/workbench/services/extensions/browser/appServerExtensionService.js';
import { ILanguagePackService } from '../../../src/ash/platform/languagePacks/common/languagePacks.js';
import { createEmptyTestLanguagePacks } from '../../../src/ash/workbench/services/localization/test/common/localizationTestUtils.js';
import { IExtensionHostApi } from '../../../src/ash/platform/agentHost/common/extensionHostApi.js';
import { createDisconnectedExtensionHostApi } from '../../../src/ash/platform/agentHost/browser/extensionHostApi.js';
import { WebWorkerExtensionHost } from '../../../src/ash/workbench/services/extensions/browser/webWorkerExtensionHost.js';
import { MainThreadImageEditors } from '../../../src/ash/workbench/api/browser/mainThreadImageEditors.js';
import { MainThreadLocalization } from '../../../src/ash/workbench/api/browser/mainThreadLocalization.js';
import { createExtensionHostInitialization } from '../../../src/ash/workbench/services/extensions/common/extensionHostProtocol.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../src/ash/platform/workspace/common/workspace.js';
import type { ExtensionClientOperation } from '../../../src/ash/workbench/api/common/extHost.protocol.js';

/** Real prepared package, Worker, SDK registration and production image adapter; only the backend catalog is injected. */
export async function startSnapshotFixture(parent: InstantiationService, resources: DisposableStore): Promise<{ stop(): Promise<void>; runCode(): Promise<void>; }> {
	const builtin = createBuiltinExtensionFixture();
	let enabled = true;
	const packages: IExtensionApi = { ...builtin, list: async () => { const catalog = await builtin.list('cached'); return { ...catalog, extensions: catalog.extensions.filter(entry => enabled && entry.id === 'ash.snapshot') }; } };
	const services = resources.add(parent.createChild(new ServiceCollection(
		[IExtensionApi, packages], [ILanguagePackService, createEmptyTestLanguagePacks()], [IAdapterManager, resources.add(new AdapterManager())],
		[IImageEditorService, parent.get(IImageEditorService)],
	)));
	const extensions = resources.add(services.createInstance(AppServerExtensionService, { api: packages }));
	services.registerInstance(IExtensionService, extensions);
	await extensions.start();
	const host = resources.add(services.createInstance(WebWorkerExtensionHost, packages, createDisconnectedExtensionHostApi(() => Promise.reject(new Error('No external runtime in this fixture')))));
	services.registerInstance(IExtensionHostApi, host);
	const adapter = resources.add(services.createInstance(MainThreadImageEditors, 30_000));
	const changes = host.onDidChange(() => { void host.list().then(snapshot => adapter.update(snapshot)); });
	resources.add(toDisposable(() => changes.dispose()));
	const configuration = services.get(IConfigurationService);
	const workspace = services.get(IWorkspaceContextService);
	const handler = host.registerClientHandler(async (value, signal, source) => {
		const operation = value as ExtensionClientOperation;
		if (operation.operation === 'readInitialization') {
			const localization = await services.createInstance(MainThreadLocalization).getLocalization(source.extensionId);
			return { result: 'initialization', initialization: { ...createExtensionHostInitialization(workspace, configuration), ...(localization ? { localization } : {}) } };
		}
		if (operation.operation === 'editorOperation') { await adapter.show(operation.payload, signal, source); return { result: 'value', value: null }; }
		throw new Error(`Unexpected Snapshot client operation: ${operation.operation}`);
	});
	resources.add(toDisposable(() => handler.dispose()));
	const snapshot = await host.reconcile('refresh');
	const owner = snapshot.extensions.find(entry => entry.id === 'ash.snapshot');
	if (owner?.lifecycle !== 'ready') throw new Error(`Snapshot failed to activate: ${JSON.stringify(owner?.failure ?? snapshot)}`);
	adapter.update(snapshot);
	if (!services.get(IImageEditorService).available) throw new Error(`Snapshot did not register its image editor: ${JSON.stringify(owner.registrations)}`);
	const stop = async () => { enabled = false; adapter.update(await host.reconcile('refresh')); };
	resources.add(toDisposable(() => { adapter.clear(); host.dispose(); }));
	return { stop, async runCode() { await host.invoke({ extensionId: owner.id, incarnation: owner.incarnation!, activationGeneration: owner.activationGeneration, registrationId: 'snapshot.code', operation: 'execute', payload: { arguments: [] }, deadlineUnixMillis: Date.now() + 30_000 }, new AbortController().signal); } };
}
