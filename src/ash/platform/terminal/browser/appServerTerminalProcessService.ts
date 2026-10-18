import { type IDisposable, toDisposable } from "../../../base/common/lifecycle.js";
import { decodeBase64 } from "../../../base/common/buffer.js";
import type { IAppServerApi } from "../../agentHost/common/appServerApi.js";
import type { TerminalReadResult, TerminalCommandStatusEvent, TerminalProcessReady } from "../../../../../.build/protocol/typescript/index.js";
import type { AppServerProtocolClient } from "../../agentHost/browser/appServerProtocolClient.js";
import { appServerRequest, voidResult } from "../../agentHost/browser/appServerRequest.js";
import { GeneralShellType, PosixShellType } from '../common/terminal.js';
import type {
	ITerminalProcessCloseOptions, ITerminalProcessCreateOptions, ITerminalProcessCreation,
	ITerminalProcessInfo, ITerminalProcessReady, TerminalShellIntegrationEvent,
	ITerminalProcessProfile, ITerminalProcessCommandStatusEvent, ITerminalProcessReadOptions, ITerminalProcessReadResult,
	ITerminalProcessResizeOptions, ITerminalProcessService, ITerminalProcessWriteOptions,
	TerminalProcessConnectionState, ITerminalResolvedProfile, TerminalProcessProfileSelection,
} from "../common/terminal.js";

/** App Server implementation of the terminal process service. */
export class AppServerTerminalProcessService implements ITerminalProcessService {
	constructor(private readonly connection: AppServerProtocolClient, private readonly appServerApi: IAppServerApi) { }

	get operatingSystem() { return this.connection.operatingSystem; }

	async listProfiles(dirId?: string): Promise<readonly ITerminalProcessProfile[]> {
		const result = await appServerRequest(this.connection, "terminal/profile/list", { dirId });
		return result.profiles;
	}

	async resolveProfile(profile: TerminalProcessProfileSelection, dirId?: string): Promise<ITerminalResolvedProfile> {
		return appServerRequest(this.connection, 'terminal/profile/resolve', { dirId, profile: profileSelection(profile) });
	}

	async getEnvironment(names?: readonly string[], dirId?: string): Promise<Readonly<Record<string, string>>> {
		const result = await appServerRequest(this.connection, "terminal/environment/read", { names: names && [...names], dirId });
		return result.values;
	}

	async create(options: ITerminalProcessCreateOptions): Promise<ITerminalProcessCreation> {
		const execution = options.execution?.type === 'process' ? { ...options.execution, args: typeof options.execution.args === 'string' ? options.execution.args : [...options.execution.args] } : options.execution;
		const created = await appServerRequest(this.connection, "terminal/create", { ...options, profile: profileSelection(options.profile), execution, lifecycle: { type: "connectionOwned" } });
		return { ready: decodeTerminalProcessReady(created.ready), terminalId: created.terminalId, profile: created.profile, connectionPersistence: "connectionOwned" };
	}

	async getProcessInfo(options: ITerminalProcessCloseOptions): Promise<ITerminalProcessInfo> {
		const result = await appServerRequest(this.connection, 'terminal/processInfo', options);
		return { ...result, ready: decodeTerminalProcessReady(result.ready), cwd: result.cwd ?? undefined };
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

	sendSignal(options: ITerminalProcessCloseOptions & { readonly signal: 'interrupt'; }): Promise<void> {
		return voidResult(appServerRequest(this.connection, 'terminal/sendSignal', options));
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

/** Copies readonly domain collections into the generated transport request. */
export function profileSelection(profile: TerminalProcessProfileSelection) {
	return profile.type === 'custom' ? { ...profile, path: [...profile.path], args: typeof profile.args === 'string' ? profile.args : [...profile.args] } : profile;
}

/** Spawn and attach use the same execution-owned shell identity. */
export function decodeTerminalProcessReady(ready: TerminalProcessReady): ITerminalProcessReady {
	const shellType = ready.shellType === 'bash' ? PosixShellType.Bash : ready.shellType === 'zsh' ? PosixShellType.Zsh : ready.shellType === 'pwsh' ? GeneralShellType.PowerShell : undefined;
	return { pid: ready.pid, cwd: ready.cwd, ...(shellType === undefined ? {} : { shellType }) };
}

/** Both connection lifecycles expose the same frontend bytes and exit-code semantics. */
export function decodeTerminalProcessReadResult(result: TerminalReadResult): ITerminalProcessReadResult {
	return {
		terminalId: result.terminalId,
		chunks: result.chunks.map(chunk => ({
			sequence: chunk.sequence,
			data: decodeBase64(chunk.dataBase64).buffer,
			...(chunk.shellIntegration === undefined ? {} : { shellIntegration: decodeShellBoundary(chunk.shellIntegration, result.terminalId) }),
		})),
		nextSequence: result.nextSequence,
		outputGap: result.outputGap,
		commandEvents: result.commandEvents.map(decodeCommandEvent),
		nextCommandSequence: result.nextCommandSequence,
		commandEventGap: result.commandEventGap,
		exited: result.exited,
		exitCode: result.exitCode ?? undefined,
		...(result.cwd == null ? {} : { cwd: result.cwd }),
		...(result.shellIntegration == null ? {} : {
			shellIntegration: {
				...result.shellIntegration,
				promptType: result.shellIntegration.promptType ?? undefined,
				commands: result.shellIntegration.commands.map(decodeCommandEvent),
			}
		}),
	};
}

function decodeCommandEvent(event: TerminalCommandStatusEvent): ITerminalProcessCommandStatusEvent {
	return {
		sequence: event.sequence, commandId: event.commandId, status: event.status,
		exitCode: event.exitCode ?? undefined, afterOutputSequence: event.afterOutputSequence,
		...(event.cwd == null ? {} : { cwd: event.cwd }),
		...(event.command == null ? {} : { command: event.command }),
		...(event.isTrusted == null ? {} : { isTrusted: event.isTrusted }),
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

function decodeShellBoundary(event: NonNullable<TerminalReadResult['chunks'][number]['shellIntegration']>, terminalId: string): TerminalShellIntegrationEvent {
	switch (event.type) {
		case 'processReady': return {
			...event,
			shellType: event.shellType === 'bash' ? PosixShellType.Bash : event.shellType === 'zsh' ? PosixShellType.Zsh : event.shellType === 'pwsh' ? GeneralShellType.PowerShell : undefined,
		};
		case 'environment': return { ...event, values: event.values == null ? undefined : Object.fromEntries(Object.entries(event.values).map(([key, value]) => [key, value ?? undefined])) };
		case 'environmentEntry':
		case 'environmentDelete': return { ...event, value: event.value ?? undefined };
		case 'commandExecuted': return { ...event, commandId: `${terminalId}:${event.commandId}`, command: event.command ?? undefined, cwd: event.cwd ?? undefined };
		case 'commandFinished': return { ...event, exitCode: event.exitCode ?? undefined, durationMillis: event.durationMillis ?? undefined };
		default: return event;
	}
}
