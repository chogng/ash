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
