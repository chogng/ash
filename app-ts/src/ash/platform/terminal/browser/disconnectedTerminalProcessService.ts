import { type IDisposable, toDisposable } from "../../../base/common/lifecycle.js";
import type { IAppServerApi } from "../../app-server/common/appServerApi.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { ITerminalProcessCloseOptions, ITerminalProcessCreateOptions, ITerminalProcessCreation, ITerminalProcessProfile, ITerminalProcessReadOptions, ITerminalProcessReadResult, ITerminalProcessResizeOptions, ITerminalProcessService, ITerminalProcessWriteOptions, TerminalProcessConnectionState } from "../common/terminalProcessService.js";

/** Terminal process service used when no browser App Server host is available. */
export class DisconnectedTerminalProcessService implements ITerminalProcessService {
	constructor(private readonly unavailable: UnavailableOperation, private readonly appServerApi: IAppServerApi) {}

	listProfiles(): Promise<readonly ITerminalProcessProfile[]> {
		return this.unavailable("terminal.listProfiles");
	}

	create(_options: ITerminalProcessCreateOptions): Promise<ITerminalProcessCreation> {
		return this.unavailable("terminal.create");
	}

	write(_options: ITerminalProcessWriteOptions): Promise<void> {
		return this.unavailable("terminal.write");
	}

	resize(_options: ITerminalProcessResizeOptions): Promise<void> {
		return this.unavailable("terminal.resize");
	}

	read(_options: ITerminalProcessReadOptions): Promise<ITerminalProcessReadResult> {
		return this.unavailable("terminal.read");
	}

	close(_options: ITerminalProcessCloseOptions): Promise<void> {
		return this.unavailable("terminal.close");
	}

	getConnectionState(): Promise<TerminalProcessConnectionState> {
		return this.appServerApi.getConnectionState();
	}

	onConnectionState(listener: (state: TerminalProcessConnectionState) => void): IDisposable {
		const subscription = this.appServerApi.onConnectionState(listener);
		return toDisposable(() => subscription.dispose());
	}
}
