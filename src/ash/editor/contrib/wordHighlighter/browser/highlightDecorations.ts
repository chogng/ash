import './highlightDecorations.css';
import { DocumentHighlightKind } from '../../../common/languages.js';

export function getDocumentHighlightDecorationClassName(kind: DocumentHighlightKind | undefined): string {
	if (kind === DocumentHighlightKind.Write) return 'word-highlight-strong';
	if (kind === DocumentHighlightKind.Text) return 'word-highlight-text';
	return 'word-highlight';
}
