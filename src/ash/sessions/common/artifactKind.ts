import type { ResolvedChatContext } from '../../workbench/services/chat/common/chatContextService.js';

export const artifactKinds = ['docs', 'slides', 'design', 'sheet', 'whiteboard', 'data', 'motion'] as const;

export type ArtifactKind = typeof artifactKinds[number];

export function isArtifactKind(value: unknown): value is ArtifactKind {
	return artifactKinds.some(kind => kind === value);
}

export type RequestArtifactKind = Extract<ArtifactKind, 'sheet' | 'slides'>;

export function isRequestArtifactKind(value: unknown): value is RequestArtifactKind {
	return value === 'sheet' || value === 'slides';
}

export function getArtifactRequestContext(kind: RequestArtifactKind): ResolvedChatContext {
	return kind === 'sheet'
		? { name: 'ash.creation.sheet', content: 'Create the spreadsheet requested by the user. Structure the rows and columns, include the needed formulas, and explain assumptions or inputs. Use formats you can actually produce.' }
		: { name: 'ash.creation.slides', content: 'Create the presentation requested by the user. Develop a clear narrative and provide slide-by-slide content, with speaker notes or visual direction where useful. Use a format you can actually produce.' };
}
