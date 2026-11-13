import type { ArtifactCard } from './artifactWorkspaceRegistry.js';

interface ArtifactExamples {
	readonly heading: string;
	readonly accessibilityHelp: string;
	readonly cards: readonly ArtifactCard[];
}

let examples: ArtifactExamples | undefined;

export function registerArtifactExamples(section: ArtifactExamples): void {
	if (examples) throw new Error('Artifact examples are already registered');
	examples = section;
}

export function getArtifactExamples(): ArtifactExamples | undefined {
	return examples;
}
