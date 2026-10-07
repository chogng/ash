import { APP_SERVER_PROTOCOL_MAJOR, APP_SERVER_SCHEMA_HASH, type InitializeResult, type ServerCapabilities } from '../../../../../crates/app-server-protocol/schema/typescript/index.js';
import { decodeAppServerResult } from '../../../../../crates/app-server-protocol/schema/typescript/AppServerProtocolDecoder.js';
import { localize } from '../../../nls.js';

type AppServerCapabilityName = Exclude<keyof ServerCapabilities, 'contracts'>;

export const requiredSessionCapabilities: readonly AppServerCapabilityName[] = ['sessions', 'threads', 'turns'];

export type AppServerProtocolIncompatibility =
	| { readonly kind: 'majorVersion'; readonly expected: number; readonly received: number; }
	| { readonly kind: 'schemaHash'; readonly expected: string; readonly received: string; }
	| { readonly kind: 'missingCapability'; readonly name: string; };

/** Initialization failure that a host may recover by selecting another trusted runtime. */
export class AppServerProtocolIncompatibleError extends Error {
	public constructor(public readonly incompatibility: AppServerProtocolIncompatibility) {
		super(describeIncompatibility(incompatibility));
		this.name = 'AppServerProtocolIncompatibleError';
	}
}

export interface AppServerProtocolDiagnostics {
	readonly clientProtocolMajor: number;
	readonly serverProtocolMajor: number;
	readonly clientSchemaHash: string;
	readonly serverSchemaHash: string;
	readonly schemaMatches: boolean;
}

export interface ValidateAppServerInitializeOptions {
	readonly expectedServerName?: string;
	readonly requiredCapabilities?: readonly AppServerCapabilityName[];
}

export function validateAppServerInitializeResult(value: unknown, options: ValidateAppServerInitializeOptions = {}): InitializeResult {
	const initialized = decodeAppServerResult('initialize', value);
	const { serverInfo, protocolVersion, capabilities } = initialized;
	if (options.expectedServerName && serverInfo.name !== options.expectedServerName) {
		throw new Error(`Unexpected App Server identity: ${serverInfo.name}`);
	}
	if (protocolVersion.major !== APP_SERVER_PROTOCOL_MAJOR) {
		throw new AppServerProtocolIncompatibleError({ kind: 'majorVersion', expected: APP_SERVER_PROTOCOL_MAJOR, received: protocolVersion.major });
	}
	if (initialized.schemaHash !== APP_SERVER_SCHEMA_HASH) {
		throw new AppServerProtocolIncompatibleError({ kind: 'schemaHash', expected: APP_SERVER_SCHEMA_HASH, received: initialized.schemaHash });
	}
	for (const name of options.requiredCapabilities ?? requiredSessionCapabilities) {
		if (capabilities[name] !== true) {
			throw new AppServerProtocolIncompatibleError({ kind: 'missingCapability', name });
		}
	}
	return initialized;
}

export function appServerProtocolDiagnostics(initialized: InitializeResult): AppServerProtocolDiagnostics {
	return {
		clientProtocolMajor: APP_SERVER_PROTOCOL_MAJOR,
		serverProtocolMajor: initialized.protocolVersion.major,
		clientSchemaHash: APP_SERVER_SCHEMA_HASH,
		serverSchemaHash: initialized.schemaHash,
		schemaMatches: initialized.schemaHash === APP_SERVER_SCHEMA_HASH,
	};
}

function describeIncompatibility(incompatibility: AppServerProtocolIncompatibility): string {
	switch (incompatibility.kind) {
		case 'majorVersion':
			return localize('appServer.protocol.majorMismatch', 'Ash App Server protocol major mismatch: client requires {0}, server advertised {1}', incompatibility.expected, incompatibility.received);
		case 'schemaHash':
			return localize('appServer.protocol.schemaMismatch', 'Ash App Server protocol schema mismatch: client requires {0}, server advertised {1}. Rebuild and start the matching backend.', incompatibility.expected, incompatibility.received);
		case 'missingCapability':
			return localize('appServer.protocol.missingCapability', 'Ash App Server is missing required capability {0}', incompatibility.name);
	}
}
