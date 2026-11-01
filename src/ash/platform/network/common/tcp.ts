import type { SessionCreateParams } from '../../agentHost/common/agent.js';

export type TcpExecutionTarget = Extract<NonNullable<SessionCreateParams['executionTarget']>, { readonly type: 'ssh' | 'provider'; }>;

/** Byte streams belong to one backend connection; routing remains fixed for their lifetime. */
export interface ITcpService {
	readonly generation: number;
	open(id: string, host: string, port: number, target?: TcpExecutionTarget): Promise<void>;
	read(id: string, target?: TcpExecutionTarget): Promise<{ readonly bytes: Uint8Array; readonly eof: boolean; }>;
	write(id: string, bytes: Uint8Array, target?: TcpExecutionTarget): Promise<number>;
	end(id: string, target?: TcpExecutionTarget): Promise<void>;
	close(id: string, target?: TcpExecutionTarget): Promise<void>;
}
