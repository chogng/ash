import type { CancellationToken } from '../../../base/common/cancellation.js';
import type { URI } from '../../../base/common/uri.js';

export interface ArtifactOrigin {
	readonly chat: string;
	readonly turnId?: string;
}

/** Durable identity supplied by the authority that owns the session. */
export interface ArtifactRecord {
	readonly id: string;
	readonly resource: string;
	readonly label: string;
	readonly isArtifact?: boolean;
	readonly origin?: ArtifactOrigin;
}

export function artifactBindingId(authority: string, session: string, artifactId: string, integrationId: string): string {
	return JSON.stringify([authority, session, artifactId, integrationId]);
}

export interface ArtifactAction {
	readonly id: string;
	readonly label: string;
	/** Describes the effect the user authorizes by selecting this action. */
	readonly description: string;
	/** Revalidates the approved target and returns the operation to dispatch. */
	prepare(token: CancellationToken): Promise<() => Promise<void>>;
}

export interface IArtifactIntegrationBinding {
	readonly id: string;
	readonly artifact: ArtifactRecord;
	readonly actions: readonly ArtifactAction[];
	/** Explains why an otherwise relevant action is unavailable. */
	readonly unavailableReason?: string;
}
/** The resource provider retains ownership of authorization and execution. */
export interface IArtifactIntegration {
	readonly id: string;
	match(resource: URI, token: CancellationToken, artifact: ArtifactRecord): boolean;
	createBinding(session: string, artifact: ArtifactRecord, id: string, token: CancellationToken): Promise<IArtifactIntegrationBinding>;
}
