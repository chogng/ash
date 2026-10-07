import { addDisposableListener, hasAppFocus } from '../../../../base/browser/dom.js';
import { getWindows, onDidRegisterWindow, onDidUnregisterWindow } from '../../../../base/browser/window.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
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

	public async getScreenshot(): Promise<Uint8Array | undefined> {
		this.assertNotDisposed();
		const resources = this._register(new DisposableStore());
		let stream: MediaStream | undefined;
		const video = this.ownerWindow.document.createElement('video');
		video.muted = true;
		try {
			stream = await this.ownerWindow.navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
			if (resources.isDisposed) return undefined;
			video.srcObject = stream;
			const ready = new Promise<void>((resolve, reject) => {
				resources.add(addDisposableListener(video, 'loadeddata', () => resolve()));
				resources.add(addDisposableListener(video, 'error', () => reject(new Error('The screenshot video could not be read'))));
				const timeout = this.ownerWindow.setTimeout(() => reject(new Error('The screenshot video did not produce a frame')), 10_000);
				resources.add(toDisposable(() => this.ownerWindow.clearTimeout(timeout)));
				resources.add(toDisposable(() => reject(new Error('The screenshot capture has closed'))));
			});
			await Promise.all([video.play(), ready]);
			const canvas = this.ownerWindow.document.createElement('canvas');
			canvas.width = video.videoWidth;
			canvas.height = video.videoHeight;
			const context = canvas.getContext('2d');
			if (!context || !canvas.width || !canvas.height) throw new Error('The screenshot frame is empty');
			context.drawImage(video, 0, 0);
			const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
			if (!blob) throw new Error('The screenshot could not be encoded');
			return new Uint8Array(await blob.arrayBuffer());
		} catch (error) {
			if (error instanceof DOMException && error.name === 'NotAllowedError') return undefined;
			throw error;
		} finally {
			// Permission may resolve after host disposal. Always stop the returned stream, including that late result.
			stream?.getTracks().forEach(track => track.stop());
			video.pause();
			video.srcObject = null;
			this._store.delete(resources);
			resources.dispose();
		}
	}

	public async openWindow(options: IOpenEmptyWindowOptions = {}): Promise<void> {
		if (options.remoteAuthority !== undefined) throw new Error('This browser host cannot open a Remote window');
		const url = new URL(this.ownerWindow.location.href);
		url.searchParams.delete('folder');
		if (!options.forceReuseWindow) {
			this.ownerWindow.open(url.href, '_blank');
			return;
		}
		try {
			await this.lifecycle.shutdown('load');
		} catch (error) {
			if (error instanceof ShutdownVetoError) return;
			throw error;
		}
		this.ownerWindow.sessionStorage.setItem(EMPTY_WORKSPACE_ID_KEY, `empty-window-${crypto.randomUUID()}`);
		this.ownerWindow.location.assign(url.href);
	}
}
