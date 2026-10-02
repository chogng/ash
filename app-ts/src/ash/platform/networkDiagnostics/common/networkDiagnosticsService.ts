import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export type HttpCompatibilityMode = 'http2' | 'http1';
export type NetworkPurpose = 'model' | 'signIn' | 'usage' | 'service';
export type NetworkRoute = { readonly type: 'direct' } | { readonly type: 'proxy'; readonly host: string; readonly port: number } | { readonly type: 'blocked' };
export type NetworkFailure = 'dns' | 'proxy' | 'tls' | 'certificateConfiguration' | 'connect' | 'timeout' | 'policy' | 'configuration' | 'request' | 'authentication' | 'accountChanged' | 'accountOperation';

export interface NetworkTarget {
	readonly id: string;
	readonly connection: string;
	readonly displayName: string;
	readonly host: string;
	readonly port: number;
	readonly purpose: NetworkPurpose;
	readonly route: NetworkRoute;
}

export interface NetworkSnapshot {
	readonly revision: number;
	readonly httpMode: HttpCompatibilityMode;
	readonly targets: readonly NetworkTarget[];
}

export interface NetworkCheck {
	readonly connection: string;
	readonly targetId: string | null;
	readonly outcome: { readonly type: 'reachable'; readonly httpStatus: number } | { readonly type: 'accountAvailable' } | { readonly type: 'failed'; readonly failure: NetworkFailure };
}

export interface NetworkDiagnostics {
	readonly network: NetworkSnapshot;
	readonly checks: readonly NetworkCheck[];
}

/** Backend-owned application transport settings and a point-in-time connectivity report. */
export interface INetworkDiagnosticsService {
	read(): Promise<NetworkSnapshot>;
	configureHttp(mode: HttpCompatibilityMode, expectedRevision: number): Promise<void>;
	/** The bounded backend probe runs to completion; connection closure terminates its work. */
	run(): Promise<NetworkDiagnostics>;
}

export const INetworkDiagnosticsService = createServiceIdentifier<INetworkDiagnosticsService>('networkDiagnosticsService');
