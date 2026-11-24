import { SessionArtifactType, type ISessionArtifact } from '../../platform/agentHost/common/sessionArtifacts.js';
import type { ArtifactResource } from '../../platform/artifactCatalog/common/artifactCatalog.js';

/** Native document creation publishes one Markdown document for a response. */
export function agentHostResponseArtifactId(threadId: string, itemId: string): string {
	return JSON.stringify([threadId, itemId, 'markdown']);
}

/** Adapts published references without retaining document content or another catalog. */
export function agentHostSessionArtifacts(files: readonly ArtifactResource[]): readonly ISessionArtifact[] {
	return files.filter(file => file.source.partId === 'markdown')
		.map(file => ({
			id: agentHostResponseArtifactId(file.source.threadId, file.source.itemId),
			chat: file.source.threadId,
			type: SessionArtifactType.File,
			label: file.title,
			isArtifact: true,
			uri: file.resource.toString(),
		}));
}
