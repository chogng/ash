import { type IDisposable, toDisposable } from "../../../base/common/lifecycle.js";
import { type IAppServerApi } from "../../agentHost/common/appServerApi.js";
import { type AppServerProtocolClient } from "../../agentHost/browser/appServerProtocolClient.js";
import { appServerRequest, voidResult } from "../../agentHost/browser/appServerRequest.js";
import { type IDebugAdapterProcessReadResult, type IDebugAdapterProcessService, type IDebugAdapterProcessStartOptions } from "../common/debugAdapterProcessService.js";
import { type RendererHostCapabilities } from "../../renderer/common/rendererHost.js";
import { generateUuid } from "../../../base/common/uuid.js";
import { localize } from "../../../nls.js";

/** App Server adapter for App Server-owned DAP processes. */
export class AppServerDebugAdapterProcessService implements IDebugAdapterProcessService {
	private readonly sessions = new Map<string, { readonly sessionId: string; readonly dirId?: string; }>();
	constructor(private readonly connection: AppServerProtocolClient, private readonly appServer: IAppServerApi) { }

	async start(options: IDebugAdapterProcessStartOptions): Promise<string> {
		const sessionId = (await appServerRequest(this.connection, "debug/adapter/start", { ...options, arguments: [...options.arguments] })).sessionId;
		// Backend IDs are folder-scoped; callers need a handle unique across all folders.
		const handle = generateUuid();
		this.sessions.set(handle, { sessionId, ...(options.dirId === undefined ? {} : { dirId: options.dirId }) });
		return handle;
	}

	async send(sessionId: string, message: unknown): Promise<void> {
		await voidResult(appServerRequest(this.connection, "debug/adapter/send", { ...this.session(sessionId), message }));
	}

	async read(sessionId: string, afterSequence: number, maxMessages: number): Promise<IDebugAdapterProcessReadResult> {
		return appServerRequest(this.connection, "debug/adapter/read", { ...this.session(sessionId), afterSequence, maxMessages });
	}

	async close(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) { return; }
		this.sessions.delete(sessionId);
		await voidResult(appServerRequest(this.connection, "debug/adapter/close", session));
	}

	private session(sessionId: string): { readonly sessionId: string; readonly dirId?: string; } {
		const session = this.sessions.get(sessionId);
		if (!session) { throw new Error(localize('debug.adapterSessionUnavailable', 'The debug adapter session is no longer available.')); }
		return session;
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
