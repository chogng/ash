import type { IOpenEmptyWindowOptions } from '../../../../platform/window/common/window.js';
import { ILifecycleService, ShutdownVetoError } from '../../lifecycle/common/lifecycle.js';
import { IHostService } from './host.js';

export const EMPTY_WORKSPACE_ID_KEY = 'ash.workbench.emptyWorkspaceId';

export class BrowserHostService implements IHostService {
	private readonly ownerWindow = window;
	constructor(@ILifecycleService private readonly lifecycle: ILifecycleService) {}

	public async restart(): Promise<void> {
		// A restart retains the workspace and dirty backups; 'load' replaces it.
		try { await this.lifecycle.shutdown('reload'); }
		catch (error) { if (error instanceof ShutdownVetoError) { return; } throw error; }
		this.ownerWindow.location.reload();
	}

	public async openWindow(options: IOpenEmptyWindowOptions = {}): Promise<void> {
		if (options.remoteAuthority !== undefined) throw new Error('This browser host cannot open a Remote window');
		if (!options.forceReuseWindow) {
			this.ownerWindow.open(this.ownerWindow.location.href, '_blank');
			return;
		}
		try {
			await this.lifecycle.shutdown('load');
		} catch (error) {
			if (error instanceof ShutdownVetoError) return;
			throw error;
		}
		this.ownerWindow.sessionStorage.setItem(EMPTY_WORKSPACE_ID_KEY, `empty-window-${crypto.randomUUID()}`);
		this.ownerWindow.location.reload();
	}
}
