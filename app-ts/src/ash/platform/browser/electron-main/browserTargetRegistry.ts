import type { BrowserViewTargetId } from "../common/browserView.js";
import type { EventEmitter } from 'node:events';

export interface BrowserDebuggerClient {
	isAttached(): boolean;
	attach(protocolVersion?: string): void;
	detach(): void;
	sendCommand(method: string, commandParams?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
}

export interface BrowserTargetWebContents extends Pick<EventEmitter, 'on' | 'removeListener'> {
	readonly debugger: BrowserDebuggerClient;
	isDestroyed(): boolean;
	isLoading(): boolean;
	capturePage(): Promise<{ toPNG(): Buffer }>;
}

export interface BrowserTargetView {
	readonly webContents: BrowserTargetWebContents;
	getBounds(): { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface BrowserTargetHandle {
	readonly targetId: BrowserViewTargetId;
	readonly webContents: BrowserTargetWebContents;
	readonly view: BrowserTargetView;
	readonly signal: AbortSignal;
}

/** Main-only registry exposing exact live browser targets to trusted host capabilities. */
export class BrowserTargetRegistry {
	private readonly targets = new Map<BrowserViewTargetId, { readonly handle: BrowserTargetHandle; readonly cancellation: AbortController }>();

	register(targetId: BrowserViewTargetId, view: BrowserTargetView): void {
		if (this.targets.has(targetId)) {
			throw new Error("BrowserTargetAlreadyRegistered");
		}
		const cancellation = new AbortController();
		this.targets.set(targetId, { handle: { targetId, webContents: view.webContents, view, signal: cancellation.signal }, cancellation });
	}

	unregister(targetId: BrowserViewTargetId): void {
		const target = this.targets.get(targetId);
		if (target) {
			this.targets.delete(targetId);
			target.cancellation.abort(new Error('BrowserTargetUnavailable'));
		}
	}

	target(targetId: string): BrowserTargetHandle {
		const target = this.targets.get(targetId);
		if (!target || target.handle.webContents.isDestroyed()) {
			throw new Error("BrowserTargetUnavailable");
		}
		return target.handle;
	}
}
