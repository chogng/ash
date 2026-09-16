import { type DebugAdapterCloseParams, type DebugAdapterReadResult, type DebugAdapterSendParams, type DebugAdapterStartParams, type DebugAdapterStartResult } from "../../app-server/common/generated/index.js";
import { type IDisposable, toDisposable } from "../../../base/common/lifecycle.js";
import { type IAppServerApi } from "../../app-server/common/appServerApi.js";
import { invoke } from "../../ipc/electron-browser/rendererIpc.js";
import { type IDebugAdapterProcessReadResult, type IDebugAdapterProcessService, type IDebugAdapterProcessStartOptions } from "../common/debugAdapterProcessService.js";
import { type RendererHostCapabilities } from "../../renderer/common/rendererHost.js";

/** Electron renderer adapter for App Server-owned DAP processes. */
export class ElectronDebugAdapterProcessService implements IDebugAdapterProcessService {
	private readonly workspaceFolders = new Map<string, string | undefined>();

	constructor(private readonly appServer: IAppServerApi) {}

	async start(options: IDebugAdapterProcessStartOptions): Promise<string> {
		const params: DebugAdapterStartParams = { ...workspaceFolder(options.dirId), program: options.program, arguments: [...options.arguments] };
		const sessionId = (await invoke<DebugAdapterStartResult>("ash:debug-adapter:start", params)).sessionId;
		this.workspaceFolders.set(sessionId, options.dirId);
		return sessionId;
	}

	send(sessionId: string, message: unknown): Promise<void> {
		const params: DebugAdapterSendParams = { ...workspaceFolder(this.workspaceFolders.get(sessionId)), sessionId, message };
		return invoke<void>("ash:debug-adapter:send", params);
	}

	read(sessionId: string, afterSequence: number, maxMessages: number): Promise<IDebugAdapterProcessReadResult> {
		return invoke<DebugAdapterReadResult>("ash:debug-adapter:read", { ...workspaceFolder(this.workspaceFolders.get(sessionId)), sessionId, afterSequence, maxMessages });
	}

	close(sessionId: string): Promise<void> {
		const params: DebugAdapterCloseParams = { ...workspaceFolder(this.workspaceFolders.get(sessionId)), sessionId };
		return invoke<void>("ash:debug-adapter:close", params).finally(() => this.workspaceFolders.delete(sessionId));
	}

	getConnectionState() { return this.appServer.getConnectionState(); }

	onConnectionState(listener: Parameters<IAppServerApi["onConnectionState"]>[0]): IDisposable {
		const subscription = this.appServer.onConnectionState(listener);
		return toDisposable(() => subscription.dispose());
	}
}

function workspaceFolder(dirId: string | undefined): { readonly dirId?: string } {
	return dirId === undefined ? {} : { dirId };
}

/** Code product contribution for the Electron renderer host. */
export function createElectronDebugAdapterCapability(appServer: IAppServerApi): RendererHostCapabilities {
	return { debugAdapter: new ElectronDebugAdapterProcessService(appServer) };
}
