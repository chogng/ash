export const artifactKinds = ['docs', 'slides', 'design', 'sheet', 'whiteboard', 'data', 'motion'] as const;

export type ArtifactKind = typeof artifactKinds[number];

export function isArtifactKind(value: unknown): value is ArtifactKind {
	return artifactKinds.some(kind => kind === value);
}
