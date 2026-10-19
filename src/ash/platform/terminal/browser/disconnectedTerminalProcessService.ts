import { type IDisposable, toDisposable } from "../../../base/common/lifecycle.js";
import type { IAppServerApi } from "../../agentHost/common/appServerApi.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { ITerminalResolvedProfile, ITerminalProcessInfo, TerminalProcessProfileSelection, ITerminalProcessCloseOptions, ITerminalProcessCreateOptions, ITerminalProcessCreation, ITerminalProcessProfile, ITerminalProcessReadOptions, ITerminalProcessReadResult, ITerminalProcessResizeOptions, ITerminalProcessService, ITerminalProcessWriteOptions, TerminalProcessConnectionState } from "../common/terminal.js";

/** Terminal process service used when no browser App Server host is available. */
export class DisconnectedTerminalProcessService implements ITerminalProcessService {
	constructor(private readonly unavailable: UnavailableOperation, private readonly appServerApi: IAppServerApi) { }

	readonly operatingSystem = undefined;

	listProfiles(): Promise<readonly ITerminalProcessProfile[]> {
		return this.unavailable("terminal.listProfiles");
	}

	resolveProfile(_profile: TerminalProcessProfileSelection, _dirId?: string): Promise<ITerminalResolvedProfile> {
		return this.unavailable('terminal.resolveProfile');
	}

	getEnvironment(_names?: readonly string[], _dirId?: string): Promise<Readonly<Record<string, string>>> {
		return this.unavailable("terminal.getEnvironment");
	}

	create(_options: ITerminalProcessCreateOptions): Promise<ITerminalProcessCreation> {
		return this.unavailable("terminal.create");
	}

	getProcessInfo(_options: ITerminalProcessCloseOptions): Promise<ITerminalProcessInfo> {
		return this.unavailable('terminal.getProcessInfo');
	}

	write(_options: ITerminalProcessWriteOptions): Promise<void> {
		return this.unavailable("terminal.write");
	}

	resize(_options: ITerminalProcessResizeOptions): Promise<void> {
		return this.unavailable("terminal.resize");
	}

	sendSignal(): Promise<void> {
		return this.unavailable('terminal.sendSignal');
	}

	setAutoReplies(): Promise<void> {
		return this.unavailable('terminal.setAutoReplies');
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
