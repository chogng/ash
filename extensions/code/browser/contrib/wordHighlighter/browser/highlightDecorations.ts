import './highlightDecorations.css';
import { DocumentHighlightKind } from '../../../../../../src/ash/editor/common/languages.js';

export function getDocumentHighlightDecorationClassName(kind: DocumentHighlightKind | undefined): string {
	if (kind === DocumentHighlightKind.Write) return 'word-highlight-strong';
	if (kind === DocumentHighlightKind.Text) return 'word-highlight-text';
	return 'word-highlight';
}
