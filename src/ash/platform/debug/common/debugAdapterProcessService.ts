import { type IDisposable } from "../../../base/common/lifecycle.js";
import { type AppServerConnectionState } from "../../agentHost/common/appServerApi.js";
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

export type DebugAdapterConnection = {
	readonly type: 'server';
	readonly port: number;
	readonly host?: string;
} | {
	readonly type: 'namedPipe';
	readonly path: string;
};

export type IDebugAdapterProcessStartOptions = {
	readonly dirId?: string;
	readonly arguments: readonly string[];
} & ({
	readonly program: string;
	readonly connection?: never;
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string | null>>;
} | {
	readonly connection: DebugAdapterConnection;
	readonly program?: never;
	readonly cwd?: never;
	readonly env?: never;
});

export interface IDebugAdapterProcessMessage {
	readonly sequence: number;
	readonly message: unknown;
}

export interface IDebugAdapterProcessReadResult {
	readonly messages: readonly IDebugAdapterProcessMessage[];
	readonly nextSequence: number;
	readonly outputGap: boolean;
	readonly stderr: string;
	readonly exited: boolean;
	readonly exitCode: number | null;
	readonly protocolError: string | null;
}

/** Platform contract for one connection-owned Debug Adapter Protocol process. */
export interface IDebugAdapterProcessService {
	start(options: IDebugAdapterProcessStartOptions): Promise<string>;
	send(sessionId: string, message: unknown): Promise<void>;
	read(sessionId: string, afterSequence: number, maxMessages: number): Promise<IDebugAdapterProcessReadResult>;
	close(sessionId: string): Promise<void>;
	getConnectionState(): Promise<AppServerConnectionState>;
	onConnectionState(listener: (state: AppServerConnectionState) => void): IDisposable;
}

/** Debug composition registers its selected capability; undefined means the host cannot launch DAP processes. */
export const IDebugAdapterProcessService = createServiceIdentifier<IDebugAdapterProcessService | undefined>("debugAdapterProcessService");
