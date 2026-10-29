import { Disposable } from '../../../../base/common/lifecycle.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import type { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import type { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';

/** The trusted IPC context selects the window's memory store; callers cannot select another window. */
export class SecretStorageService extends Disposable implements ISecretStorageService {
	readonly type = 'in-memory' as const;
	private readonly channel: IChannel;
	readonly onDidChangeSecret;
	constructor(@IMainProcessService main: IMainProcessService) {
		super();
		this.channel = main.getChannel('secretStorage');
		this.onDidChangeSecret = this.channel.listen<string>('onDidChangeSecret');
	}
	get(key: string): Promise<string | undefined> {
		return this.channel.call('get', [key]);
	}
	set(key: string, value: string): Promise<void> {
		return this.channel.call('set', [key, value]);
	}
	delete(key: string): Promise<void> {
		return this.channel.call('delete', [key]);
	}
	keys(): Promise<string[]> {
		return this.channel.call('keys');
	}
}
