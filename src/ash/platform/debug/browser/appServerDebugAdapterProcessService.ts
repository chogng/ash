import { type IDisposable, toDisposable } from "../../../base/common/lifecycle.js";
import { type IAppServerApi } from "../../agentHost/common/appServerApi.js";
import { type AppServerProtocolClient } from "../../agentHost/browser/appServerProtocolClient.js";
import { appServerRequest, voidResult } from "../../agentHost/browser/appServerRequest.js";
import { type IDebugAdapterProcessReadResult, type IDebugAdapterProcessService, type IDebugAdapterProcessStartOptions } from "../common/debugAdapterProcessService.js";
import { type RendererHostCapabilities } from "../../renderer/common/rendererHost.js";

/** App Server adapter for App Server-owned DAP processes. */
export class AppServerDebugAdapterProcessService implements IDebugAdapterProcessService {
	private readonly workspaceFolders = new Map<string, string | undefined>();
	constructor(private readonly connection: AppServerProtocolClient, private readonly appServer: IAppServerApi) { }

	async start(options: IDebugAdapterProcessStartOptions): Promise<string> {
		const sessionId = (await appServerRequest(this.connection, "debug/adapter/start", { ...options, arguments: [...options.arguments] })).sessionId;
		this.workspaceFolders.set(sessionId, options.dirId);
		return sessionId;
	}

	send(sessionId: string, message: unknown): Promise<void> {
		return voidResult(appServerRequest(this.connection, "debug/adapter/send", { ...this.folder(sessionId), sessionId, message }));
	}

	read(sessionId: string, afterSequence: number, maxMessages: number): Promise<IDebugAdapterProcessReadResult> {
		return appServerRequest(this.connection, "debug/adapter/read", { ...this.folder(sessionId), sessionId, afterSequence, maxMessages });
	}

	close(sessionId: string): Promise<void> {
		return voidResult(appServerRequest(this.connection, "debug/adapter/close", { ...this.folder(sessionId), sessionId })).finally(() => this.workspaceFolders.delete(sessionId));
	}

	private folder(sessionId: string): { readonly dirId?: string; } { const dirId = this.workspaceFolders.get(sessionId); return dirId === undefined ? {} : { dirId }; }

	getConnectionState() { return this.appServer.getConnectionState(); }

	onConnectionState(listener: Parameters<IAppServerApi["onConnectionState"]>[0]): IDisposable {
		const subscription = this.appServer.onConnectionState(listener);
		return toDisposable(() => subscription.dispose());
	}
}

/** Code product contribution for the connected Vite renderer host. */
export function createAppServerDebugAdapterCapability(connection: AppServerProtocolClient, appServer: IAppServerApi): RendererHostCapabilities {
	return { debugAdapter: new AppServerDebugAdapterProcessService(connection, appServer) };
}
