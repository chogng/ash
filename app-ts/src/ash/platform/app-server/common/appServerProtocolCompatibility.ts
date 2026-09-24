import { APP_SERVER_CAPABILITY_VERSION, APP_SERVER_PROTOCOL_MAJOR, APP_SERVER_SCHEMA_HASH, type InitializeResult, type ServerCapabilities } from './generated/index.js';
import { decodeAppServerResult } from './generated/AppServerProtocolDecoder.js';

const serverCapabilityFields = [
	'agentInteractions',
	'documentCollaboration',
	'sessions',
	'threads',
	'turns',
	'projects',
	'resources',
	'attachments',
	'fileSystem',
	'git',
	'contentSearch',
	'codebase',
	'cloudCodebase',
	'terminal',
	'debugAdapter',
	'typst',
	'updateReplay',
	'extensions',
	'extensionHost',
	'connectors',
	'plugins',
	'marketplace',
	'mcp',
	'mcpOAuth',
] as const satisfies readonly (keyof ServerCapabilities)[];

export interface AppServerCapabilityRequirement {
	readonly name: string;
	readonly minVersion: number;
	readonly maxVersion: number;
}

export const requiredSessionCapabilities: readonly AppServerCapabilityRequirement[] = [
	{ name: 'sessions', minVersion: APP_SERVER_CAPABILITY_VERSION, maxVersion: APP_SERVER_CAPABILITY_VERSION },
	{ name: 'threads', minVersion: APP_SERVER_CAPABILITY_VERSION, maxVersion: APP_SERVER_CAPABILITY_VERSION },
	{ name: 'turns', minVersion: APP_SERVER_CAPABILITY_VERSION, maxVersion: APP_SERVER_CAPABILITY_VERSION },
];

export type AppServerProtocolIncompatibility =
	| { readonly kind: 'majorVersion'; readonly expected: number; readonly received: number }
	| { readonly kind: 'missingCapability'; readonly name: string; readonly minVersion: number; readonly maxVersion: number }
	| { readonly kind: 'capabilityVersion'; readonly name: string; readonly minVersion: number; readonly maxVersion: number; readonly received: number };

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
	readonly serverProtocolRevision: number;
	readonly clientSchemaHash: string;
	readonly serverSchemaHash: string;
	readonly schemaMatches: boolean;
}

export interface ValidateAppServerInitializeOptions {
	readonly expectedServerName?: string;
	readonly requiredCapabilities?: readonly AppServerCapabilityRequirement[];
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
	for (const requirement of options.requiredCapabilities ?? requiredSessionCapabilities) {
		const booleanField = serverCapabilityFields.find(field => field === requirement.name);
		if (booleanField && capabilities[booleanField] !== true) {
			throw new AppServerProtocolIncompatibleError({ kind: 'missingCapability', ...requirement });
		}
		const contract = capabilities.contracts[requirement.name];
		if (contract === undefined) {
			throw new AppServerProtocolIncompatibleError({ kind: 'missingCapability', ...requirement });
		}
		const version = contract.version;
		if (version < requirement.minVersion || version > requirement.maxVersion) {
			throw new AppServerProtocolIncompatibleError({ kind: 'capabilityVersion', ...requirement, received: version });
		}
	}
	return initialized;
}

export function appServerProtocolDiagnostics(initialized: InitializeResult): AppServerProtocolDiagnostics {
	return {
		clientProtocolMajor: APP_SERVER_PROTOCOL_MAJOR,
		serverProtocolMajor: initialized.protocolVersion.major,
		serverProtocolRevision: initialized.protocolVersion.revision,
		clientSchemaHash: APP_SERVER_SCHEMA_HASH,
		serverSchemaHash: initialized.schemaHash,
		schemaMatches: initialized.schemaHash === APP_SERVER_SCHEMA_HASH,
	};
}

function describeIncompatibility(incompatibility: AppServerProtocolIncompatibility): string {
	switch (incompatibility.kind) {
		case 'majorVersion':
			return `Ash App Server protocol major mismatch: Desktop requires ${incompatibility.expected}, server advertised ${incompatibility.received}`;
		case 'missingCapability':
			return `Ash App Server is missing required capability ${incompatibility.name}; Desktop supports versions ${incompatibility.minVersion}-${incompatibility.maxVersion}`;
		case 'capabilityVersion':
			return `Ash App Server capability ${incompatibility.name} is incompatible: Desktop supports versions ${incompatibility.minVersion}-${incompatibility.maxVersion}, server advertised ${incompatibility.received}`;
	}
}
