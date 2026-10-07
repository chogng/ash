import { type IDisposable, toDisposable } from "../../../base/common/lifecycle.js";
import { decodeBase64 } from "../../../base/common/buffer.js";
import type { IAppServerApi } from "../../app-server/common/appServerApi.js";
import type { TerminalReadResult } from "../../app-server/common/generated/index.js";
import type { AppServerProtocolClient } from "../../app-server/browser/appServerProtocolClient.js";
import { appServerRequest, voidResult } from "../../app-server/browser/appServerRequest.js";
import type {
	ITerminalProcessCloseOptions, ITerminalProcessCreateOptions, ITerminalProcessCreation,
	ITerminalProcessProfile, ITerminalProcessReadOptions, ITerminalProcessReadResult,
	ITerminalProcessResizeOptions, ITerminalProcessService, ITerminalProcessWriteOptions,
	TerminalProcessConnectionState,
} from "../common/terminal.js";

/** App Server implementation of the terminal process service. */
export class AppServerTerminalProcessService implements ITerminalProcessService {
	constructor(private readonly connection: AppServerProtocolClient, private readonly appServerApi: IAppServerApi) { }

	async listProfiles(): Promise<readonly ITerminalProcessProfile[]> {
		const result = await appServerRequest(this.connection, "terminal/profile/list", {});
		return result.profiles;
	}

	async create(options: ITerminalProcessCreateOptions): Promise<ITerminalProcessCreation> {
		const created = await appServerRequest(this.connection, "terminal/create", { ...options, lifecycle: { type: "connectionOwned" } });
		return { ready: created.ready, terminalId: created.terminalId, profile: created.profile, connectionPersistence: "connectionOwned" };
	}

	write(options: ITerminalProcessWriteOptions): Promise<void> {
		const { data, ...identity } = options;
		if (typeof data === 'string') {
			return voidResult(appServerRequest(this.connection, 'terminal/write', { ...identity, data }));
		}
		return voidResult(appServerRequest(this.connection, 'terminal/writeBinary', { ...identity, dataBase64: encodeTerminalProcessInput(data) }));
	}

	resize(options: ITerminalProcessResizeOptions): Promise<void> {
		return voidResult(appServerRequest(this.connection, "terminal/resize", options));
	}

	async read(options: ITerminalProcessReadOptions): Promise<ITerminalProcessReadResult> {
		const result = await appServerRequest(this.connection, "terminal/read", options);
		return decodeTerminalProcessReadResult(result);
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

/** Both connection lifecycles expose the same frontend bytes and exit-code semantics. */
export function decodeTerminalProcessReadResult(result: TerminalReadResult): ITerminalProcessReadResult {
	return {
		terminalId: result.terminalId,
		chunks: result.chunks.map(chunk => ({
			sequence: chunk.sequence,
			data: decodeBase64(chunk.dataBase64).buffer,
		})),
		nextSequence: result.nextSequence,
		outputGap: result.outputGap,
		commandEvents: result.commandEvents.map(event => ({
			sequence: event.sequence,
			commandId: event.commandId,
			status: event.status,
			exitCode: event.exitCode ?? undefined,
			afterOutputSequence: event.afterOutputSequence,
		})),
		nextCommandSequence: result.nextCommandSequence,
		commandEventGap: result.commandEventGap,
		exited: result.exited,
		exitCode: result.exitCode ?? undefined,
	};
}

/** Encodes raw input for both local and reconnectable protocol adapters. */
export function encodeTerminalProcessInput(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}
