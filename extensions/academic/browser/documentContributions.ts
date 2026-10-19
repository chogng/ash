import type { IDisposable } from '../../../src/ash/base/common/lifecycle.js';
import type { DocumentNode } from '../common/model/document.js';
import type { DocumentSchema, DocumentTextStyleAttributes } from '../common/model/documentSchema.js';
import type { DocumentSelection } from '../common/core/documentSelection.js';
import type { DocumentCommand } from '../common/commands/documentCommands.js';
import { FormattingContribution } from './contrib/formatting/formattingContribution.js';
import { ParagraphStyleContribution } from './contrib/paragraphStyle/paragraphStyle.js';
import { ParagraphFormattingContribution } from './contrib/paragraphFormatting/paragraphFormatting.js';

export interface DocumentFormattingState {
	/** Immutable selected paragraphs; controls derive mixed values instead of caching document state. */
	readonly paragraphs?: readonly DocumentNode[];
	readonly context: 'none' | 'text' | 'code';
	readonly readOnly: boolean;
	readonly bold: boolean;
	readonly italic: boolean;
	readonly fontFamily: 'sans' | 'serif' | 'monospace' | undefined;
	readonly fontSize: number | undefined;
	readonly checkedDocumentActionIds: ReadonlySet<string>;
}

export interface DocumentFormattingContribution extends IDisposable {
	readonly element: HTMLElement;
	setState(state: DocumentFormattingState): void;
}

export interface DocumentEditorContributionContext {
	readonly kind: 'document';
	readonly container: HTMLElement;
	readonly documentActions: readonly { readonly id: string; readonly label: string; }[];
	readonly onToggleMark: (markType: 'strong' | 'em') => void;
	readonly onSetTextStyle: (attrs: DocumentTextStyleAttributes) => void;
	readonly onClearTextStyle: () => void;
	readonly onRunDocumentAction: (actionId: string) => void;
	/** The Widget owns each control's mounting, state updates and disposal. */
	readonly addFormattingContribution: (contribution: DocumentFormattingContribution) => void;
	/** Resolve the current model/selection at invocation; contributors never retain a mutable model. */
	readonly runDocumentCommand: (create: (schema: DocumentSchema, document: DocumentNode, blockId: string, selection: DocumentSelection | undefined) => DocumentCommand | undefined) => void;
}


/** A profile installs controls only into its own view lifetime. */
export type DocumentContribution = (context: DocumentEditorContributionContext) => void;
export const documentContributions: readonly DocumentContribution[] = Object.freeze([
	context => context.addFormattingContribution(new FormattingContribution(context.container, context)),
	context => context.addFormattingContribution(new ParagraphStyleContribution(context)),
	context => context.addFormattingContribution(new ParagraphFormattingContribution(context)),
]);
