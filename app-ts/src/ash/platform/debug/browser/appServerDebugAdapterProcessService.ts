import { type IDisposable, toDisposable } from "../../../base/common/lifecycle.js";
import { type IAppServerApi } from "../../app-server/common/appServerApi.js";
import { type AppServerProtocolClient } from "../../app-server/browser/appServerProtocolClient.js";
import { appServerRequest, voidResult } from "../../app-server/browser/appServerRequest.js";
import { type IDebugAdapterProcessReadResult, type IDebugAdapterProcessService, type IDebugAdapterProcessStartOptions } from "../common/debugAdapterProcessService.js";
import { type RendererHostCapabilities } from "../../renderer/common/rendererHost.js";

/** App Server adapter for App Server-owned DAP processes. */
export class AppServerDebugAdapterProcessService implements IDebugAdapterProcessService {
	constructor(private readonly connection: AppServerProtocolClient, private readonly appServer: IAppServerApi) {}

	async start(options: IDebugAdapterProcessStartOptions): Promise<string> {
		return (await appServerRequest(this.connection, "debug/adapter/start", { program: options.program, arguments: [...options.arguments] })).sessionId;
	}

	send(sessionId: string, message: unknown): Promise<void> {
		return voidResult(appServerRequest(this.connection, "debug/adapter/send", { sessionId, message }));
	}

	read(sessionId: string, afterSequence: number, maxMessages: number): Promise<IDebugAdapterProcessReadResult> {
		return appServerRequest(this.connection, "debug/adapter/read", { sessionId, afterSequence, maxMessages });
	}

	close(sessionId: string): Promise<void> {
		return voidResult(appServerRequest(this.connection, "debug/adapter/close", { sessionId }));
	}

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
