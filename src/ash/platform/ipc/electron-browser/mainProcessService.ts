import { Client } from '../../../base/parts/ipc/electron-browser/ipc.electron.js';
import type { IChannel, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import type { IMainProcessService } from '../common/mainProcessService.js';

/** One instance and one connection are owned by each renderer document. */
export class ElectronIPCMainProcessService extends Disposable implements IMainProcessService {
	declare public readonly _serviceBrand: undefined;
	private readonly connection: Client;
	constructor(windowId: number) {
		super();
		this.connection = this._register(new Client(`window:${windowId}`));
	}
	public getChannel(name: string): IChannel { return this.connection.getChannel(name); }
	public registerChannel(name: string, channel: IServerChannel<string>): void { this.connection.registerChannel(name, channel); }
}
