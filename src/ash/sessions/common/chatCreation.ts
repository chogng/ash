import type { ResolvedChatContext } from '../../workbench/services/chat/common/chatContextService.js';

export const chatCreationKinds = ['docs', 'slides', 'design', 'sheet', 'whiteboard', 'data', 'motion'] as const;

export type ChatCreationKind = typeof chatCreationKinds[number];

export function isChatCreationKind(value: unknown): value is ChatCreationKind {
	return chatCreationKinds.some(kind => kind === value);
}

const creationInstructions: Record<ChatCreationKind, string> = {
	docs: 'Create the document requested by the user. Your final reply must be the complete, standalone Markdown document, without an outer code fence. Do not reply with only a file path, a summary of what you created, or a completion notice. Ash saves the final reply body as a .md file after the turn completes.',
	slides: 'Create the presentation requested by the user. Develop a clear narrative and provide slide-by-slide content, with speaker notes or visual direction where useful. Use a format you can actually produce; do not claim that an Ash-native slide file or editor is available.',
	design: 'Create the design requested by the user. Provide a concrete visual concept, layout, typography, colors and implementation details or assets appropriate to the request. Use formats you can actually produce; do not claim that an Ash-native design file or editor is available.',
	sheet: 'Create the spreadsheet requested by the user. Structure the rows and columns, include the needed formulas, and explain assumptions or inputs. Use formats you can actually produce; do not claim that an Ash-native spreadsheet file or editor is available.',
	whiteboard: 'Create the whiteboard requested by the user. Organize the ideas spatially with clear groups, relationships and labels, using a diagram or structured content appropriate to the request. Use formats you can actually produce; do not claim that an Ash-native whiteboard file or editor is available.',
	data: 'Create the data analysis requested by the user. Work from the available data, make calculations and assumptions explicit, and provide useful tables, findings and visualization specifications or runnable code. Use formats you can actually produce; do not claim that an Ash-native data file or editor is available.',
	motion: 'Create the motion work requested by the user. Develop the timing, scenes, transitions and animation behavior, with executable code or a concrete storyboard where appropriate. Use formats you can actually produce; do not claim that an Ash-native motion file or editor is available.',
};

/** The stable context name survives accepted Turn persistence and history replay. */
export function getChatCreationContext(kind: ChatCreationKind): ResolvedChatContext {
	return { name: `ash.creation.${kind}`, content: creationInstructions[kind] };
}
