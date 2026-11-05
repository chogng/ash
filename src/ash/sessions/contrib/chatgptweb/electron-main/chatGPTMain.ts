import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, session } from 'electron/main';
import { toDisposable, type DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { IChannelServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { createAppServerDaemonLauncher } from '../../../../platform/app-server-daemon/electron-main/appServerDaemonLauncher.js';
import type { DevelopmentAppServerReloader } from '../../../../platform/app-server-daemon/electron-main/developmentAppServerReloader.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { chatGPTTransportChannel } from '../common/chatGPTTransport.js';
import { ChatGPTAuthentication } from './chatGPTAuthentication.js';
import { ChatGPTTransport, type ChatGPTTransportOptions } from './chatGPTTransport.js';
import { ChatGPTVerificationRuntime } from './chatGPTVerificationRuntime.js';

interface ChatGPTMainOptions {
	readonly profileRoot: string;
	readonly rendererRoot: string;
	readonly credentialsEnabled: boolean;
	readonly registerDevelopmentConnection: (generationFile: string, ...connection: Parameters<DevelopmentAppServerReloader['registerConnection']>) => IDisposable;
}

/** Registers the desktop adapter and binds its transport to each Agents window's lifetime. */
export class ChatGPTMain {
	private readonly channels = new Map<string, IServerChannel<string>>();

	constructor(
		ipc: IChannelServer<string>,
		private readonly options: ChatGPTMainOptions,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		ipc.registerChannel(chatGPTTransportChannel, {
			call: (context, command, arg) => this.getWindowChannel(context).call(context, command, arg),
			listen: (context, event, arg) => this.getWindowChannel(context).listen(context, event, arg),
		});
	}

	attachWindow(windowId: number, resources: DisposableStore): void {
		const connection = this.options.credentialsEnabled ? createAppServerDaemonLauncher({
			packageLocation: { appPath: app.getAppPath(), expectedVersion: app.getVersion(), isPackaged: app.isPackaged, platform: process.platform, resourcesPath: process.resourcesPath },
			sourceEnvironment: process.env, profileRoot: this.options.profileRoot, electronExecutable: process.execPath, role: 'credentials',
		}) : undefined;
		if (connection) resources.add(connection.launcher);
		const authentication = resources.add(new ChatGPTAuthentication(connection ? { enabled: true, launcher: connection.launcher } : { enabled: false }));
		if (connection?.generationFile) {
			resources.add(this.options.registerDevelopmentConnection(connection.generationFile, connection.launcher, authentication));
		}
		const transport = resources.add(this.instantiation.createInstance(ChatGPTTransport, {
			authentication,
			readVerificationScript: signal => this.readVerificationScript(signal),
			createRuntime: authorize => new ChatGPTVerificationRuntime(authorize),
		} satisfies ChatGPTTransportOptions));
		const context = `window:${windowId}`;
		this.channels.set(context, transport.getChannel());
		resources.add(toDisposable(() => this.channels.delete(context)));
	}

	private getWindowChannel(context: string): IServerChannel<string> {
		const channel = this.channels.get(context);
		if (!channel) throw new Error('ChatGPT is unavailable in this window');
		return channel;
	}

	private async readVerificationScript(signal: AbortSignal): Promise<string> {
		const devURL = process.env.ASH_RENDERER_URL;
		if (devURL) {
			const response = await session.defaultSession.fetch(new URL('browser/chatgpt/verification.js', devURL).href, { signal });
			if (!response.ok) throw new Error('ChatGPT verification script is unavailable');
			return response.text();
		}
		return readFile(join(this.options.rendererRoot, 'browser/chatgpt/verification.js'), { encoding: 'utf8', signal });
	}
}
