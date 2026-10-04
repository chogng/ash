import { INativeHostService } from '../../../common/services.js';
import type { INativeHostApi } from '../../../../platform/native/common/nativeHost.js';
import type { IOpenEmptyWindowOptions } from '../../../../platform/window/common/window.js';
import { BrowserHostService } from '../browser/browserHostService.js';
import { ILifecycleService } from '../../lifecycle/common/lifecycle.js';
import { HOST_RESTART_CHANNEL } from '../../../../platform/window/common/window.js';
import { invoke } from '../../../../platform/ipc/electron-browser/rendererIpc.js';

export class NativeHostService extends BrowserHostService {
	constructor(
		@INativeHostService private readonly host: INativeHostApi,
		@ILifecycleService lifecycle: ILifecycleService,
	) { super(lifecycle); }

	public override restart(): Promise<void> { return invoke<void>(HOST_RESTART_CHANNEL); }

	public override openWindow(options: IOpenEmptyWindowOptions = {}): Promise<void> {
		return this.host.openWindow(options);
	}
}
