import { type IDisposable } from "../../../base/common/lifecycle.js";
import { type AppServerConnectionState } from "../../app-server/common/appServerApi.js";
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

export interface IDebugAdapterProcessStartOptions {
	readonly dirId?: string;
	readonly program: string;
	readonly arguments: readonly string[];
}

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

export const IDebugAdapterProcessService = createServiceIdentifier<IDebugAdapterProcessService>("debugAdapterProcessService");
