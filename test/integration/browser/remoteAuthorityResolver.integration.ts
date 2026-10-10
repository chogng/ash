import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { createDisconnectedAppServerApi } from '../../../src/ash/platform/agentHost/browser/appServerApi.js';
import { IAppServerApi } from '../../../src/ash/platform/agentHost/common/appServerApi.js';
import { createBrowserExtensionApi } from '../../../src/ash/platform/extensions/browser/extensionApi.js';
import type { ExtensionSourceKind } from '../../../src/ash/platform/extensions/common/extensionApi.js';
import { ExtensionResourceLoaderService } from '../../../src/ash/platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import { BrowserExtensionHostApi, createDisconnectedExtensionHostApi } from '../../../src/ash/platform/extensionHost/browser/extensionHostApi.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { FileService } from '../../../src/ash/platform/files/common/fileService.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../src/ash/platform/workspace/common/workspace.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import chinese from '../../../localization/zh-CN/workbench.json' with { type: 'json' };

const resources = new DisposableStore();
const services = resources.add(new InstantiationService());
services.registerInstance(ICommandService, { onWillExecuteCommand: Event.None, onDidExecuteCommand: Event.None, executeCommand: async () => { throw new Error('SSH registration must not execute a command'); } });
const packages = createBrowserExtensionApi();
const unavailable = (operation: string): never => { throw new Error(`Unexpected backend operation: ${operation}`); };
services.registerInstance(IFileService, resources.add(new FileService()));
services.registerInstance(IWorkspaceContextService, { onDidChangeWorkspace: Event.None, getWorkspace: () => ({ id: 'empty', folders: [] }), getWorkbenchState: () => WorkbenchState.EMPTY, getWorkspaceFolder: () => null });
services.registerInstance(IAppServerApi, createDisconnectedAppServerApi(unavailable));
let host: BrowserExtensionHostApi | undefined;

async function activate(sourceKind: ExtensionSourceKind = 'user', id = 'attacker.ssh', language = 'en') {
	setNlsMessages(language, language === 'zh-CN' ? chinese : {});
	host?.dispose();
	const source = `export function activate(context) { context.register({ kind: 'remoteConnectionResolver', registrationId: 'ssh', authorityPrefix: 'ssh' }, () => ({ connectionName: 'build' })); }`;
	host = resources.add(services.createInstance(BrowserExtensionHostApi, {
		resources: new ExtensionResourceLoaderService(async () => new TextEncoder().encode(source)),
		list: async () => {
			const catalog = await packages.list('cached');
			const extension = catalog.extensions.find(extension => extension.id === 'ash.remote-ssh');
			if (!extension) { throw new Error('Missing distributed SSH package'); }
			return { ...catalog, extensions: [{ ...extension, sourceKind, id, manifestJson: JSON.stringify({ browser: './extension.js' }) }] };
		},
	}, createDisconnectedExtensionHostApi(unavailable)));
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
