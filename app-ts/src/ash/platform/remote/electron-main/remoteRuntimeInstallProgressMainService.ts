import { Emitter } from "../../../base/common/event.js";
import type { Event } from "../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../base/common/lifecycle.js";
import { createSshRemoteAuthority } from "../common/remote.js";
import type { RemoteRuntimeInstallProgress } from "../common/remoteRuntimeInstallProgress.js";
import type { RemoteRuntimeInstallProgressState } from "../common/remoteRuntimeInstallProgress.js";

/** Handle owned by the provision attempt that currently feeds the bootstrap UI. */
export interface RemoteRuntimeInstallProgressOperation {
	readonly signal: AbortSignal;
	report(progress: RemoteRuntimeInstallProgress): void;
	finish(): void;
}

interface ActiveInstallOperation {
	readonly identity: symbol;
	readonly cancellation: AbortController;
	state: RemoteRuntimeInstallProgressState;
}

/** Owns one cancellable, credential-free Remote runtime installation projection. */
export class RemoteRuntimeInstallProgressMainService extends Disposable {
	private readonly changeEmitter = this._register(new Emitter<RemoteRuntimeInstallProgressState | undefined>());
	private active: ActiveInstallOperation | undefined;

	readonly onDidChange: Event<RemoteRuntimeInstallProgressState | undefined> = this.changeEmitter.event;

	constructor() {
		super();
		this._register(toDisposable(() => {
			this.cancel();
			this.active = undefined;
		}));
	}

	getState(): RemoteRuntimeInstallProgressState | undefined {
		return this.active?.state;
	}

	begin(host: string): RemoteRuntimeInstallProgressOperation {
		this.assertNotDisposed();
		if (this.active) throw new Error("A Remote runtime installation is already active");
		const normalizedHost = createSshRemoteAuthority(host).host;
		const identity = Symbol("remoteRuntimeInstall");
		const cancellation = new AbortController();
		this.active = {
			identity,
			cancellation,
			state: Object.freeze({ host: normalizedHost, status: "installing", phase: "probingPlatform" }),
		};
		this.changeEmitter.fire(this.active.state);
		return Object.freeze({
			signal: cancellation.signal,
			report: (progress: RemoteRuntimeInstallProgress) => this.report(identity, progress),
			finish: () => this.finish(identity),
		});
	}

	cancel(): void {
		const active = this.active;
		if (!active || active.state.phase === "complete" || active.cancellation.signal.aborted) return;
		active.state = Object.freeze({ ...active.state, status: "cancelling" });
		this.changeEmitter.fire(active.state);
		active.cancellation.abort("Remote runtime installation cancelled by the user");
	}

	private report(identity: symbol, progress: RemoteRuntimeInstallProgress): void {
		const active = this.active;
		if (!active || active.identity !== identity) return;
		active.state = Object.freeze({ ...progress, host: active.state.host, status: active.state.status });
		this.changeEmitter.fire(active.state);
	}

	private finish(identity: symbol): void {
		if (this.active?.identity !== identity) return;
		this.active = undefined;
		this.changeEmitter.fire(undefined);
	}
}
