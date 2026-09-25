import { Disposable } from '../../../../base/common/lifecycle.js';
import { invoke } from '../../../../platform/ipc/electron-browser/rendererIpc.js';
import type { IKeybindingsResourceService } from '../../../../platform/keybinding/common/keybindingsResource.js';
import { NATIVE_HOST_SYNC_SYSTEM_WIDE_KEYBINDINGS_CHANNEL, validateSystemWideKeybindingsResult, type INativeSystemWideKeybinding } from '../../../../platform/native/common/nativeHost.js';

export interface ISystemWideKeybindingsSynchronizerOptions {
	readonly getCandidates: () => readonly INativeSystemWideKeybinding[];
	readonly onRegistrationFailuresChanged: (failed: readonly string[]) => void;
	readonly onError: (error: unknown) => void;
}

/** Synchronizes a window's user shortcuts after each resource change. */
export class SystemWideKeybindingsSynchronizer extends Disposable {
	private pending: Promise<void> = Promise.resolve();

	constructor(
		private readonly options: ISystemWideKeybindingsSynchronizerOptions,
		resource: IKeybindingsResourceService,
	) {
		super();
		this._register(resource.onDidChangeKeybindings(() => this.queueSync()));
		this.queueSync();
	}

	private queueSync(): void {
		this.pending = this.pending.then(async () => {
			if (this.isDisposed) return;
			try {
				const result = validateSystemWideKeybindingsResult(await invoke<unknown>(NATIVE_HOST_SYNC_SYSTEM_WIDE_KEYBINDINGS_CHANNEL, this.options.getCandidates()));
				if (!this.isDisposed) this.options.onRegistrationFailuresChanged(result.failed);
			} catch (error) {
				if (!this.isDisposed) this.options.onError(error);
			}
		});
	}
}
