import type { Event } from '../../../../base/common/event.js';

export interface CDPRequest { readonly id: number; readonly method: string; readonly params?: unknown; readonly sessionId?: string; }
export interface CDPResponse { readonly id: number; readonly result?: unknown; readonly error?: { code: number; message: string; }; readonly sessionId?: string; }
export interface CDPEvent { readonly method: string; readonly params: unknown; readonly sessionId?: string; }
export interface CDPTargetInfo {
	readonly targetId: string;
	readonly type: string;
	readonly title: string;
	readonly url: string;
	readonly attached: boolean;
	readonly canAccessOpener: boolean;
	readonly browserContextId: string;
	readonly browserViewId?: string;
}

export class CDPError extends Error {
	constructor(message: string, readonly code: number) {
		super(message);
		this.name = 'CDPError';
	}
}

export class CDPInvalidParamsError extends CDPError {
	constructor(message: string) {
		super(message, -32602);
		this.name = 'CDPInvalidParamsError';
	}
}

export class CDPMethodNotFoundError extends CDPError {
	constructor(method: string) {
		super('Method not found: ' + method, -32601);
		this.name = 'CDPMethodNotFoundError';
	}
}

export interface CDPBrowserVersion {
	readonly protocolVersion: string;
	readonly product: string;
	readonly revision: string;
	readonly userAgent: string;
	readonly jsVersion: string;
}

export interface CDPWindowBounds {
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
	readonly windowState: string;
}

export type CDPTargetEvent =
	| { readonly type: 'created' | 'changed'; readonly targetInfo: CDPTargetInfo; }
	| { readonly type: 'destroyed'; readonly targetId: string; }
	| { readonly type: 'message'; readonly targetId: string; readonly message: CDPEvent; };

/** Per-connection host operations. Membership, access checks and page lifetimes remain with the host. */
export interface ICDPBrowserHost {
	readonly targetInfo: CDPTargetInfo;
	readonly onTargetEvent: Event<CDPTargetEvent>;
	/** Wait for pages already being discovered before handling a client command. */
	whenReady(): Promise<void>;
	getTargets(): CDPTargetInfo[];
	getTargetInfo(targetId: string): CDPTargetInfo;
	getVersion(): CDPBrowserVersion;
	getWindowForTarget(targetId: string): { windowId: number; bounds: CDPWindowBounds; };
	getBrowserContexts(): string[];
	createTarget(url: string, browserContextId?: string): Promise<CDPTargetInfo>;
	activateTarget(targetId: string): void;
	closeTarget(targetId: string): Promise<void>;
	/** The host must withhold results if access is revoked while Chromium is executing. */
	sendCommand(targetId: string, method: string, params: Record<string, unknown>, sessionId?: string): Promise<unknown>;
}
