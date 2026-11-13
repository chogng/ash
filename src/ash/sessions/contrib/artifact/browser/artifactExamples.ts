import { localize } from '../../../../nls.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { artifactKinds, type ArtifactKind } from '../../../common/artifactKind.js';
import { getArtifactTitle } from './artifactKindPresentation.js';

export const OPEN_ARTIFACT_EXAMPLE = 'sessions.creator.openExample';

interface ArtifactExample {
	readonly detail: string;
	open(accessor: ServicesAccessor): Promise<void>;
}

const examples = new Map<ArtifactKind, (title: string) => ArtifactExample>();

export function registerArtifactExample(kind: ArtifactKind, create: (title: string) => ArtifactExample): void {
	if (examples.has(kind)) throw new Error(`Duplicate artifact example: ${kind}`);
	examples.set(kind, create);
}

export function getArtifactExample(kind: ArtifactKind) {
	const create = examples.get(kind);
	if (!create) return undefined;
	const title = localize('sessions.artifacts.exampleTitle', '{0} example', getArtifactTitle(kind));
	return { ...create(title), kind, title };
}

export function getArtifactExamples() {
	return artifactKinds.flatMap(kind => getArtifactExample(kind) ?? []);
}
