import type { ArtifactOrigin } from '../../artifactIntegrations/common/artifactIntegration.js';

export const enum SessionArtifactType {
	PullRequest = 'pullRequest',
	Issue = 'issue',
	Commit = 'commit',
	Website = 'website',
	File = 'file',
	Resource = 'resource',
}

/** A provider-owned reference to an output or a resource retained by a session. */
export interface ISessionArtifact {
	readonly id: string;
	/** Owning chat; absence refers to the session's main chat. */
	readonly chat?: string;
	readonly type: SessionArtifactType;
	readonly label: string;
	/** Whether the chat produced the resource rather than recorded a reference. */
	readonly isArtifact: boolean;
	readonly link?: string;
	readonly uri?: string;
	readonly commitHash?: string;
	readonly isGitHub?: boolean;
	readonly origin?: ArtifactOrigin;
}
