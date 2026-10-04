import { addDisposableListener, hasAppFocus } from '../../../../base/browser/dom.js';
import { getWindows, onDidRegisterWindow, onDidUnregisterWindow } from '../../../../base/browser/window.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import type { IOpenEmptyWindowOptions } from '../../../../platform/window/common/window.js';
import { ILifecycleService, ShutdownVetoError } from '../../lifecycle/common/lifecycle.js';
import { IHostService } from './host.js';

export const EMPTY_WORKSPACE_ID_KEY = 'ash.workbench.emptyWorkspaceId';

export class BrowserHostService extends Disposable implements IHostService {
	private readonly focusChanged = this._register(new Emitter<boolean>());
	public readonly onDidChangeFocus = this.focusChanged.event;
	public get hasFocus(): boolean { return hasAppFocus(); }
	private readonly ownerWindow = window;
	constructor(@ILifecycleService private readonly lifecycle: ILifecycleService) {
		super();
		let lastFocus = this.hasFocus;
		// Blur and focus can arrive in one window handoff; publish the aggregate after that handoff.
		const scheduler = this._register(new RunOnceScheduler(() => {
			const focus = this.hasFocus;
			if (focus === lastFocus) {
				return;
			}
			lastFocus = focus;
			this.focusChanged.fire(focus);
		}, 0));
		const listeners = this._register(new DisposableMap<Window, DisposableStore>());
		const observe = (targetWindow: Window): void => {
			const resources = new DisposableStore();
			resources.add(addDisposableListener(targetWindow, 'focus', () => scheduler.schedule()));
			resources.add(addDisposableListener(targetWindow, 'blur', () => scheduler.schedule()));
			listeners.set(targetWindow, resources);
		};
		for (const registered of getWindows()) {
			observe(registered.window);
		}
		this._register(onDidRegisterWindow(registered => observe(registered.window)));
		this._register(onDidUnregisterWindow(targetWindow => {
			listeners.deleteAndDispose(targetWindow);
			scheduler.schedule();
		}));
	}

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
