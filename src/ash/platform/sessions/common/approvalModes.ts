import { APPROVAL_MODE_DEFINITIONS } from '../../../../../.build/protocol/typescript/index.js';

export type ApprovalMode = 'manual' | 'auto' | 'bypassPermissions';

export interface ApprovalModeDefinition {
	readonly id: ApprovalMode;
	readonly label: { readonly key: string; readonly text: string; };
	readonly description: { readonly key: string; readonly text: string; };
	readonly requiresConfirmation: boolean;
}

/** Static Rust-owned metadata is available before a backend connection is established. */
export const approvalModeDefinitions: readonly ApprovalModeDefinition[] = APPROVAL_MODE_DEFINITIONS.map(definition => ({
	id: definition.id,
	label: { key: definition.label.key, text: definition.label.english },
	description: { key: definition.description.key, text: definition.description.english },
	requiresConfirmation: definition.requiresConfirmation,
}));

export function approvalModeDefinition(id: ApprovalMode): ApprovalModeDefinition {
	return approvalModeDefinitions.find(definition => definition.id === id)!;
}

/** The host's NLS resolver uses the same messages as the Rust clients. */
export function approvalModeMessages(language: 'english' | 'chinese'): Readonly<Record<string, string>> {
	return Object.fromEntries(APPROVAL_MODE_DEFINITIONS.flatMap(definition => [
		[definition.label.key, definition.label[language]],
		[definition.description.key, definition.description[language]],
	]));
}
