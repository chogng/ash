import type { IOpenAgentsWindowOptions } from '../../../../../../platform/native/common/nativeHost.js';

type InputState = NonNullable<IOpenAgentsWindowOptions['draft']>;
type InputAttachments = InputState['contexts'];

/** Attachment snapshots have their own storage lifetime, independent of edits to text or mode. */
export function serializeUntitledInputState(value: InputState | undefined): string {
	return JSON.stringify(value ? { ...value, contexts: [] } : null);
}

/** The owning draft store validates the complete state after joining its attachment payload. */
export function deserializeUntitledInputState(value: string): InputState | undefined {
	return JSON.parse(value) ?? undefined;
}

export function serializeUntitledInputAttachments(attachments: InputAttachments): string {
	return JSON.stringify(attachments);
}

export function deserializeUntitledInputAttachments(value: string): InputAttachments {
	return JSON.parse(value);
}
