import {
	APP_SERVER_CAPABILITY_VERSION, APP_SERVER_PROTOCOL_MAJOR, APP_SERVER_PROTOCOL_REVISION, APP_SERVER_SCHEMA_HASH,
	type InitializeResult, type ModelCatalogEntry,
} from '../../common/generated/index.js';

/** A complete handshake: protocol additions must update this typed fixture once. */
export function createTestInitializeResult(): InitializeResult {
	return {
		serverInfo: { name: 'ash-app-server', version: '0.1.0' },
		protocolVersion: { major: APP_SERVER_PROTOCOL_MAJOR, revision: APP_SERVER_PROTOCOL_REVISION },
		schemaHash: APP_SERVER_SCHEMA_HASH,
		slashCommands: [],
		capabilities: {
			agentInteractions: true,
			documentCollaboration: true,
			sessions: true,
			threads: true,
			turns: true,
			projects: true,
			memories: true,
			approvalEnvironment: true,
			resources: true,
			attachments: true,
			fileSystem: true,
			git: true,
			github: true,
			contentSearch: true,
			codebase: true,
			cloudCodebase: false,
			terminal: true,
			debugAdapter: true,
			typst: true,
			updateReplay: true,
			extensions: true,
			extensionHost: true,
			connectors: true,
			plugins: true,
			marketplace: true,
			mcp: true,
			mcpOAuth: true,
			contracts: {
				github: { version: 1 },
				sessions: { version: APP_SERVER_CAPABILITY_VERSION },
				threads: { version: APP_SERVER_CAPABILITY_VERSION },
				turns: { version: APP_SERVER_CAPABILITY_VERSION },
			},
		},
	};
}

export function createTestModel(entry: Pick<ModelCatalogEntry, 'model' | 'displayName'> & Partial<ModelCatalogEntry>): ModelCatalogEntry {
	return {
		discovered: false,
		contextWindow: null,
		defaultContextWindow: null,
		maximumContextWindow: null,
		contextWindowOptions: [],
		fastEnabled: false,
		autoCompactTokenLimit: null,
		capabilities: {
			tools: 'supported', reasoning: 'supported', parallelToolCalls: 'unknown',
			personality: 'unknown', imageDetailOriginal: 'unknown', fastMode: 'unknown',
		},
		description: null,
		supportedReasoningEfforts: [],
		modelReasoningEffort: null,
		defaultPersonality: null,
		settings: { inputModalities: null, verbosity: 'unknown', defaultVerbosity: null, reasoningSummary: 'unknown', defaultReasoningSummary: null, serviceTiers: null, defaultServiceTier: null, acceleration: null, toolOutputLimit: null },
		...entry,
	};
}
