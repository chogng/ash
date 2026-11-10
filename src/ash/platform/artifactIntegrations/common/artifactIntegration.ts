/** Durable identity supplied by the authority that owns the session. */
export interface ArtifactRecord {
	readonly id: string;
	readonly resource: string;
	readonly label: string;
	readonly isArtifact?: boolean;
	readonly origin?: { readonly chat: string; readonly turnId?: string; };
}

export function artifactBindingId(authority: string, session: string, artifactId: string, integrationId: string): string {
	return JSON.stringify([authority, session, artifactId, integrationId]);
}

export interface ArtifactAction {
	readonly id: string;
	readonly label: string;
	/** Describes the effect the user authorizes by selecting this action. */
	readonly description: string;
	invoke(): Promise<void>;
}

export interface IArtifactIntegrationBinding {
	readonly id: string;
	readonly artifact: ArtifactRecord;
	readonly actions: readonly ArtifactAction[];
	/** Explains why an otherwise relevant action is unavailable. */
	readonly unavailableReason?: string;
}
