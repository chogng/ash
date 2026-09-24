import type { BrowserViewTargetId } from "../common/browserView.js";

export interface BrowserDebuggerClient {
	isAttached(): boolean;
	attach(protocolVersion?: string): void;
	detach(): void;
	sendCommand(method: string, commandParams?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
}

export interface BrowserTargetWebContents {
	readonly debugger: BrowserDebuggerClient;
	isDestroyed(): boolean;
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
}

/** Main-only registry exposing exact live browser targets to trusted host capabilities. */
export class BrowserTargetRegistry {
	private readonly targets = new Map<BrowserViewTargetId, BrowserTargetHandle>();

	register(targetId: BrowserViewTargetId, view: BrowserTargetView): void {
		if (this.targets.has(targetId)) {
			throw new Error("BrowserTargetAlreadyRegistered");
		}
		this.targets.set(targetId, { targetId, webContents: view.webContents, view });
	}

	unregister(targetId: BrowserViewTargetId): void {
		this.targets.delete(targetId);
	}

	target(targetId: string): BrowserTargetHandle {
		const target = this.targets.get(targetId);
		if (!target || target.webContents.isDestroyed()) {
			throw new Error("BrowserTargetUnavailable");
		}
		return target;
	}
}
