import { type IDisposable, toDisposable } from "../../../base/common/lifecycle.js";
import type { IAppServerApi } from "../../app-server/common/appServerApi.js";
import type { AppServerProtocolClient } from "../../app-server/browser/appServerProtocolClient.js";
import { appServerRequest, voidResult } from "../../app-server/browser/appServerRequest.js";
import type { ITerminalProcessCloseOptions, ITerminalProcessCreateOptions, ITerminalProcessCreation, ITerminalProcessProfile, ITerminalProcessReadOptions, ITerminalProcessReadResult, ITerminalProcessResizeOptions, ITerminalProcessService, ITerminalProcessWriteOptions, TerminalProcessConnectionState } from "../common/terminalProcessService.js";

/** App Server implementation of the terminal process service. */
export class AppServerTerminalProcessService implements ITerminalProcessService {
	constructor(private readonly connection: AppServerProtocolClient, private readonly appServerApi: IAppServerApi) {}

	async listProfiles(): Promise<readonly ITerminalProcessProfile[]> {
		const result = await appServerRequest(this.connection, "terminal/profile/list", {});
		return result.profiles;
	}

	async create(options: ITerminalProcessCreateOptions): Promise<ITerminalProcessCreation> {
		const created = await appServerRequest(this.connection, "terminal/create", { ...options, lifecycle: { type: "connectionOwned" } });
		return { terminalId: created.terminalId, profile: created.profile, connectionPersistence: "connectionOwned" };
	}

	write(options: ITerminalProcessWriteOptions): Promise<void> {
		return voidResult(appServerRequest(this.connection, "terminal/write", options));
	}

	resize(options: ITerminalProcessResizeOptions): Promise<void> {
		return voidResult(appServerRequest(this.connection, "terminal/resize", options));
	}

	read(options: ITerminalProcessReadOptions): Promise<ITerminalProcessReadResult> {
		return appServerRequest(this.connection, "terminal/read", options);
	}

	close(options: ITerminalProcessCloseOptions): Promise<void> {
		return voidResult(appServerRequest(this.connection, "terminal/close", options));
	}

	getConnectionState(): Promise<TerminalProcessConnectionState> {
		return this.appServerApi.getConnectionState();
	}

	onConnectionState(listener: (state: TerminalProcessConnectionState) => void): IDisposable {
		const subscription = this.appServerApi.onConnectionState(listener);
		return toDisposable(() => subscription.dispose());
	}
}
