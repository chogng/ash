import { INativeHostService } from '../../../common/services.js';
import type { INativeHostApi } from '../../../../platform/native/common/nativeHost.js';
import type { IOpenEmptyWindowOptions } from '../../../../platform/window/common/window.js';
import { IHostService } from '../browser/host.js';

export class NativeHostService implements IHostService {
	constructor(@INativeHostService private readonly host: INativeHostApi) {}

	public openWindow(options: IOpenEmptyWindowOptions = {}): Promise<void> {
		return this.host.openWindow(options);
	}
}
