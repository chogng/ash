import { APPROVAL_MODE_DEFINITIONS } from '../../../../../.build/protocol/typescript/index.js';

export type ApprovalMode = 'manual' | 'auto' | 'bypassPermissions';

export interface ApprovalModeDefinition {
	readonly id: ApprovalMode;
	readonly label: { readonly key: string; readonly text: string; };
	readonly description: { readonly key: string; readonly text: string; };
	readonly requiresConfirmation: boolean;
}

/** Static Rust-owned metadata is available before a backend connection is established. */
export const approvalModeDefinitions: readonly ApprovalModeDefinition[] = APPROVAL_MODE_DEFINITIONS.map(
	(definition) => ({
		id: definition.id,
		label: { key: definition.label.key, text: definition.label.english },
		description: { key: definition.description.key, text: definition.description.english },
		requiresConfirmation: definition.requiresConfirmation
	})
);

export function approvalModeDefinition(id: ApprovalMode): ApprovalModeDefinition {
	return approvalModeDefinitions.find((definition) => definition.id === id)!;
}
