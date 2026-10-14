import { registerBuiltinEditorPane } from '../../../browser/editor.js';
import { createDocumentEditorPane } from '../../documentEditor/browser/editorProfile.js';
import { DOCUMENT_EDITOR_ID } from '../../documentEditor/browser/documentEditorInput.js';
import { academicProfile } from './academicEditorProfile.js';

// The factory alone does not claim files. The enabled ash.academic package owns
// the editor declaration and file associations, including their removal.
registerBuiltinEditorPane('ash.academic', DOCUMENT_EDITOR_ID,
	options => createDocumentEditorPane(academicProfile, options),
	{ id: academicProfile.id, contentType: academicProfile.contentType });
