import { decodeBase64, encodeBase64, VSBuffer } from '../../../base/common/buffer.js';
import { APP_SERVER_METHODS } from '../../../../../.build/protocol/typescript/index.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import type { SessionExecutionTarget } from '../../../../../.build/protocol/typescript/index.js';
import type { ITcpService, TcpExecutionTarget } from '../common/tcp.js';

/** Mechanical adapter; the backend owns sockets and retires them with this connection. */
export class AppServerTcpService implements ITcpService {
	constructor(private readonly client: AppServerProtocolClient) { }
	public get generation(): number { return this.client.generation; }
	private target(target: TcpExecutionTarget | undefined): SessionExecutionTarget | undefined {
		return target?.type === 'provider' ? { type: 'provider', providerId: target.providerId, workspace: target.workspace, root: target.root }
			: target ? { type: 'ssh', host: target.host, root: target.root } : undefined;
	}
	public async open(streamId: string, host: string, port: number, target?: TcpExecutionTarget): Promise<void> {
		await this.client.request(APP_SERVER_METHODS['browser/tcp/open'], { streamId, host, port, executionTarget: this.target(target) });
	}
	public async read(streamId: string, target?: TcpExecutionTarget) {
		const result = await this.client.request(APP_SERVER_METHODS['browser/tcp/read'], { streamId, executionTarget: this.target(target) });
		return { bytes: decodeBase64(result.dataBase64).buffer, eof: result.eof };
	}
	public async write(streamId: string, bytes: Uint8Array, target?: TcpExecutionTarget): Promise<number> {
		return (await this.client.request(APP_SERVER_METHODS['browser/tcp/write'], { streamId, eof: false, dataBase64: encodeBase64(VSBuffer.wrap(new Uint8Array(bytes))), executionTarget: this.target(target) })).written;
	}
	public async end(streamId: string, target?: TcpExecutionTarget): Promise<void> {
		await this.client.request(APP_SERVER_METHODS['browser/tcp/write'], { streamId, dataBase64: '', eof: true, executionTarget: this.target(target) });
	}
	public async close(streamId: string, target?: TcpExecutionTarget): Promise<void> {
		await this.client.request(APP_SERVER_METHODS['browser/tcp/close'], { streamId, executionTarget: this.target(target) });
	}
}
