import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, session } from 'electron/main';
import { Disposable, toDisposable, type DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { IChannelServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { createAppServerDaemonLauncher } from '../../../../platform/app-server-daemon/electron-main/appServerDaemonLauncher.js';
import type { DevelopmentAppServerReloader } from '../../../../platform/app-server-daemon/electron-main/developmentAppServerReloader.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { chatGPTNativeTransportChannel, chatGPTTransportChannel } from '../common/chatGPTTransport.js';
import { ChatGPTRecentHistoryGate } from './chatGPTRecentHistoryGate.js';
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
export class ChatGPTMain extends Disposable {
	private recentHistoryGate: ChatGPTRecentHistoryGate | undefined;
	private readonly channels = new Map<string, ReadonlyMap<string, IServerChannel<string>>>();

	constructor(
		ipc: IChannelServer<string>,
		private readonly options: ChatGPTMainOptions,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		for (const channel of [chatGPTTransportChannel, chatGPTNativeTransportChannel]) {
			ipc.registerChannel(channel, {
				call: (context, command, arg) => this.getWindowChannel(context, channel).call(context, command, arg),
				listen: (context, event, arg) => this.getWindowChannel(context, channel).listen(context, event, arg),
			});
		}
	}

	attachWindow(windowId: number, resources: DisposableStore): void {
		const context = `window:${windowId}`;
		this.channels.set(context, new Map([
			[chatGPTTransportChannel, this.createChannel(resources, 'credentials')],
			[chatGPTNativeTransportChannel, this.createChannel(resources, 'credentials-codex')],
		]));
		resources.add(toDisposable(() => this.channels.delete(context)));
	}

	private createChannel(resources: DisposableStore, role: 'credentials' | 'credentials-codex'): IServerChannel<string> {
		const connection = this.options.credentialsEnabled ? createAppServerDaemonLauncher({
			packageLocation: { appPath: app.getAppPath(), expectedVersion: app.getVersion(), isPackaged: app.isPackaged, platform: process.platform, resourcesPath: process.resourcesPath },
			sourceEnvironment: process.env, profileRoot: this.options.profileRoot, electronExecutable: process.execPath, role,
		}) : undefined;
		if (connection) resources.add(connection.launcher);
		const authentication = resources.add(new ChatGPTAuthentication(connection ? { enabled: true, launcher: connection.launcher } : { enabled: false }));
		if (connection?.generationFile) {
			resources.add(this.options.registerDevelopmentConnection(connection.generationFile, connection.launcher, authentication));
		}
		const transport = resources.add(this.instantiation.createInstance(ChatGPTTransport, {
			authentication,
			native: role === 'credentials-codex',
			recentHistoryGate: this.recentHistoryGate ??= this._register(this.instantiation.createInstance(ChatGPTRecentHistoryGate)),
			readVerificationScript: signal => this.readVerificationScript(signal),
			createRuntime: prepareRequestHeaders => new ChatGPTVerificationRuntime(prepareRequestHeaders),
		} satisfies ChatGPTTransportOptions));
		return transport.getChannel();
	}

	private getWindowChannel(context: string, name: string): IServerChannel<string> {
		const channel = this.channels.get(context)?.get(name);
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
