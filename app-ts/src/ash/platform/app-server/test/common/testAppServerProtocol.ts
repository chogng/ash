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

export function createTestModel(entry: Pick<ModelCatalogEntry, 'model' | 'display_name'> & Partial<ModelCatalogEntry>): ModelCatalogEntry {
	return {
		discovered: false,
		context_window: null,
		default_context_window: null,
		maximum_context_window: null,
		context_window_options: [],
		selected_acceleration: null, acceleration_options: [],
		auto_compact_token_limit: null,
		capabilities: {
			tools: 'supported', reasoning: 'supported', parallel_tool_calls: 'unknown',
			personality: 'unknown', image_detail_original: 'unknown', fast_mode: 'unknown',
		},
		description: null,
		supported_reasoning_efforts: [],
		default_reasoning_effort: null,
		default_personality: null,
		settings: { input_modalities: null, verbosity: 'unknown', default_verbosity: null, reasoning_summary: 'unknown', default_reasoning_summary: null, service_tiers: null, default_service_tier: null, acceleration: null, tool_output_limit: null },
		...entry,
	};
}
