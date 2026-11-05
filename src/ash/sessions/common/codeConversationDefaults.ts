import { isRecord } from '../../base/common/types.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../platform/configuration/common/configurationRegistry.js';
import { isModelReasoningEffort, modelReasoningEfforts, type ModelReasoningEffort, type ModelRef } from '../../platform/models/common/agentModels.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { agentHostSessionWorkspaceKey, buildAgentHostSessionWorkspace } from './agentHostSessionWorkspace.js';
import type { SessionWorkspaceSelection } from '../services/sessions/common/session.js';

export interface CodeConversationModel {
	readonly model: ModelRef | null;
	readonly effort?: ModelReasoningEffort;
}

export interface CodeConversationDefaults {
	/** An absent profile selection means inherit the last Code conversation choice. */
	readonly profile?: CodeConversationModel;
	readonly workspaces: Readonly<Record<string, CodeConversationModel>>;
}

export function codeConversationWorkspaceKey(selection: SessionWorkspaceSelection): string | undefined {
	return selection.type === 'current' || selection.type === 'multiple' ? undefined : agentHostSessionWorkspaceKey(buildAgentHostSessionWorkspace(selection));
}

export function parseCodeConversationModel(value: unknown): CodeConversationModel {
	if (!isRecord(value) || (value.effort !== undefined && !isModelReasoningEffort(value.effort))) {
		throw new TypeError('Invalid Code conversation model selection');
	}
	const model = value.model;
	if (model === null && value.effort === undefined) { return { model: null }; }
	if (!isRecord(model) || typeof model.provider !== 'string' || !model.provider.trim() || typeof model.model !== 'string' || !model.model.trim()) {
		throw new TypeError('Invalid Code conversation model');
	}
	return { model: { provider: model.provider, model: model.model }, ...(value.effort === undefined ? {} : { effort: value.effort }) };
}

const selectionSchema = {
	type: 'object', required: ['model'], additionalProperties: false,
	properties: {
		model: {
			type: 'object', required: ['provider', 'model'], additionalProperties: false, properties: {
				provider: { type: 'string', minLength: 1 },
				model: { type: 'string', minLength: 1 },
			}
		},
		effort: { type: 'string', enum: [...modelReasoningEfforts] },
	},
} as const;

// The Agents Window can open many directories, independently of the IDE's workspace.
// Keep the user's overrides in one profile setting keyed by the session workspace identity.
export const codeConversationDefaultsSetting = Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<CodeConversationDefaults>({
	key: 'sessions.code.conversationDefaults',
	scope: ConfigurationScope.APPLICATION,
	defaultValue: { workspaces: {} },
	schema: {
		type: 'object', additionalProperties: false, properties: {
			profile: selectionSchema,
			workspaces: { type: 'object', additionalProperties: selectionSchema },
		}
	},
	parse(value) {
		if (!isRecord(value) || (value.workspaces !== undefined && !isRecord(value.workspaces))) {
			throw new TypeError('Invalid Code conversation defaults');
		}
		const fixed = (entry: unknown): CodeConversationModel => {
			const selection = parseCodeConversationModel(entry);
			if (!selection.model) { throw new TypeError('A fixed Code default requires a model'); }
			return selection;
		};
		const profile = value.profile === undefined ? undefined : fixed(value.profile);
		const workspaces = Object.fromEntries(Object.entries(value.workspaces ?? {}).map(([key, entry]) => {
			const workspace: unknown = JSON.parse(key);
			if (!Array.isArray(workspace) || workspace.length !== 2 || !workspace.every(part => typeof part === 'string' && part.length > 0) || JSON.stringify(workspace) !== key) {
				throw new TypeError('Invalid Code workspace identity');
			}
			return [key, fixed(entry)];
		}));
		return { ...(profile ? { profile } : {}), workspaces };
	},
});
