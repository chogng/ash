import { Disposable } from '../../../../base/common/lifecycle.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import type { INativeHostApi, INativeSystemWideKeybinding } from '../../../../platform/native/common/nativeHost.js';
import { INativeHostService } from '../../../common/services.js';

export interface ISystemWideKeybindingsSynchronizerOptions {
	readonly getCandidates: () => readonly INativeSystemWideKeybinding[];
	readonly onRegistrationFailuresChanged: (failed: readonly string[]) => void;
	readonly onError: (error: unknown) => void;
}

/** Synchronizes a window's user shortcuts after each resource change. */
export class SystemWideKeybindingsSynchronizer extends Disposable {
	private pending: Promise<void> = Promise.resolve();
	private synchronizedPayload: string | undefined;

	constructor(
		private readonly options: ISystemWideKeybindingsSynchronizerOptions,
		@IKeybindingService resource: IKeybindingService,
		@INativeHostService private readonly host: INativeHostApi,
	) {
		super();
		const scheduler = this._register(new RunOnceScheduler(() => this.queueSync(), 100));
		this._register(resource.onDidUpdateKeybindings(() => scheduler.schedule()));
		this.queueSync();
	}

	private queueSync(): void {
		this.pending = this.pending.then(async () => {
			if (this.isDisposed) {
				return;
			}
			try {
				const candidates = this.options.getCandidates();
				const payload = JSON.stringify(candidates);
				if (payload === this.synchronizedPayload) {
					return;
				}
				const result = await this.host.syncSystemWideKeybindings(candidates);
				if (this.isDisposed) {
					return;
				}
				this.synchronizedPayload = result.failed.length === 0 ? payload : undefined;
				this.options.onRegistrationFailuresChanged(result.failed);
			} catch (error) {
				// An IPC failure can happen after Main applied the payload, so the next update must resend it.
				this.synchronizedPayload = undefined;
				if (!this.isDisposed) {
					this.options.onError(error);
				}
			}
		});
	}
}
