import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { createDisconnectedAppServerApi } from '../../../src/ash/platform/agentHost/browser/appServerApi.js';
import { IAppServerApi } from '../../../src/ash/platform/agentHost/common/appServerApi.js';
import { createBuiltinExtensionFixture } from '../../fixtures/browser/builtinExtensionsFixture.js';
import { IExtensionApi, type ExtensionSourceKind } from '../../../src/ash/platform/extensions/common/extensionApi.js';
import { ExtensionResourceLoaderService } from '../../../src/ash/platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import { WebWorkerExtensionHost } from '../../../src/ash/workbench/services/extensions/browser/webWorkerExtensionHost.js';
import { createDisconnectedExtensionHostApi } from '../../../src/ash/platform/agentHost/browser/extensionHostApi.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { FileService } from '../../../src/ash/platform/files/common/fileService.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../src/ash/platform/workspace/common/workspace.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import chinese from '../../../extensions/language-pack-zh-cn/translations/workbench.json' with { type: 'json' };
import { ILanguagePackService } from '../../../src/ash/platform/languagePacks/common/languagePacks.js';
import { createEmptyTestLanguagePacks } from '../../../src/ash/workbench/services/localization/test/common/localizationTestUtils.js';

const resources = new DisposableStore();
const services = resources.add(new InstantiationService());
services.registerInstance(ILanguagePackService, createEmptyTestLanguagePacks());
services.registerInstance(ICommandService, { onWillExecuteCommand: Event.None, onDidExecuteCommand: Event.None, executeCommand: async () => { throw new Error('SSH registration must not execute a command'); } });
const packages = createBuiltinExtensionFixture();
services.registerInstance(IExtensionApi, packages);
const unavailable = (operation: string): never => { throw new Error(`Unexpected backend operation: ${operation}`); };
services.registerInstance(IFileService, resources.add(new FileService()));
services.registerInstance(IWorkspaceContextService, {
	onDidChangeWorkspace: Event.None,
	onDidChangeWorkspaceFolders: Event.None,
	onDidChangeWorkbenchState: Event.None,
	onDidChangeWorkspaceName: Event.None, getWorkspace: () => ({ id: 'empty', folders: [] }), getWorkbenchState: () => WorkbenchState.EMPTY, getWorkspaceFolder: () => null
});
services.registerInstance(IAppServerApi, createDisconnectedAppServerApi(unavailable));
let host: WebWorkerExtensionHost | undefined;

async function activate(sourceKind: ExtensionSourceKind = 'user', id = 'attacker.ssh', language = 'en') {
	setNlsMessages(language, language === 'zh-CN' ? chinese : {});
	host?.dispose();
	const source = `export function activate() { return [{ kind: 'remoteConnectionResolver', registrationId: 'ssh', authorityPrefix: 'ssh' }]; } export function deactivate() {}`;
	host = resources.add(services.createInstance(WebWorkerExtensionHost, {
		resources: new ExtensionResourceLoaderService(async () => new TextEncoder().encode(source)),
		list: async () => {
			const catalog = await packages.list('cached');
			const extension = catalog.extensions.find(extension => extension.id === 'ash.remote-ssh');
			if (!extension) { throw new Error('Missing distributed SSH package'); }
			return { ...catalog, extensions: [{ ...extension, sourceKind, id, manifestJson: JSON.stringify({ browser: './extension.js' }) }] };
		},
	}, createDisconnectedExtensionHostApi(unavailable)));
	const handler = host.registerClientHandler(async operation => {
		if (!operation || typeof operation !== 'object' || !('operation' in operation) || operation.operation !== 'readInitialization') {
			throw new Error('SSH registration must not execute a client operation');
		}
		return { result: 'initialization', initialization: { workspaceFolders: [], workspaceName: null, workspaceFile: null, configurationValues: {}, configurationData: null } };
	});
	resources.add(toDisposable(() => handler.dispose()));
	return (await host.reconcile('refresh')).extensions[0];
}

async function packageInfo() {
	const catalog = await packages.list('cached');
	const extension = catalog.extensions.find(extension => extension.id === 'ash.remote-ssh')!;
	const read = async (path: string): Promise<string> => JSON.parse(new TextDecoder().decode(await packages.resources.readExtensionResourceBytes({ generation: catalog.generation, extensionId: extension.id, path }))).displayName;
	return { manifest: JSON.parse(extension.manifestJson), english: await read('package.nls.json'), chinese: await read('package.nls.zh-CN.json') };
}

declare global {
	interface Window {
		remoteAuthorityIntegration: { activate: typeof activate; packageInfo: typeof packageInfo; dispose(): void; };
	}
}
window.remoteAuthorityIntegration = { activate, packageInfo, dispose: () => resources.dispose() };
