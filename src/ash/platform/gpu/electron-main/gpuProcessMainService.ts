import type { App, Details, GPUFeatureStatus } from 'electron';
import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export interface IGPUProcessExit {
	readonly reason: Details['reason'];
}

export const IGPUProcessMainService = createDecorator<IGPUProcessMainService>('gpuProcessMainService');

export interface IGPUProcessMainService {
	readonly _serviceBrand: undefined;
	/** Unavailable before GPU initialization and between process exit and recovery. */
	readonly featureStatus: GPUFeatureStatus | undefined;
	readonly onDidUpdateFeatureStatus: Event<GPUFeatureStatus | undefined>;
	readonly onDidExitProcess: Event<IGPUProcessExit>;
}

/** Owns Electron GPU facts for the entire Desktop process, including software rendering. */
export class GPUProcessMainService extends Disposable implements IGPUProcessMainService {
	declare public readonly _serviceBrand: undefined;
	private status: GPUFeatureStatus | undefined;
	private readonly statusChanges = this._register(new Emitter<GPUFeatureStatus | undefined>());
	private readonly processExits = this._register(new Emitter<IGPUProcessExit>());
	public readonly onDidUpdateFeatureStatus = this.statusChanges.event;
	public readonly onDidExitProcess = this.processExits.event;

	public get featureStatus(): GPUFeatureStatus | undefined { return this.status; }

	constructor(application: App) {
		super();
		const readStatus = (): void => {
			const current = application.getGPUFeatureStatus();
			this.setStatus(current.gpu_compositing ? current : undefined);
		};
		const onExit = (_event: Electron.Event, details: Details): void => {
			if (details.type !== 'GPU') return;
			// Electron can still return the dead process's last status here.
			// Invalidate it before notifying any consumer about the exit.
			this.setStatus(undefined);
			this.processExits.fire({ reason: details.reason });
		};
		application.on('gpu-info-update', readStatus);
		application.on('child-process-gone', onExit);
		this._register(toDisposable(() => {
			application.removeListener('gpu-info-update', readStatus);
			application.removeListener('child-process-gone', onExit);
		}));
		// A late-created service must also work after the first GPU update.
		try { readStatus(); }
		catch (error) {
			this.dispose();
			throw error;
		}
	}

	private setStatus(next: GPUFeatureStatus | undefined): void {
		const previous = this.status;
		if (previous === undefined && next === undefined) return;
		if (previous && next) {
			const keys = Object.keys(next) as (keyof GPUFeatureStatus)[];
			if (keys.length === Object.keys(previous).length && keys.every(key => next[key] === previous[key])) return;
		}
		// Neither Electron nor a subscriber may mutate the shared diagnostic snapshot.
		this.status = next ? Object.freeze({ ...next }) : undefined;
		this.statusChanges.fire(this.status);
	}
}
