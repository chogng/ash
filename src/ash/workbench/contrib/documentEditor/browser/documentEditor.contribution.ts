import { localize, localize2 } from '../../../../nls.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { isDiffEditorInput } from '../../../common/editor/diffEditorInput.js';
import { GENERAL_DOCUMENT_CONTENT_TYPE, GENERAL_DOCUMENT_EDITOR_ID } from './documentEditorInput.js';
import { createDocumentEditorPane, generalProfile } from './editorProfile.js';
import { createGeneralDocument, convertActiveTextToDocument, exportActiveDocument } from './documentActions.js';
import './documentAccessibility.js';

registerEditorPane({
	id: GENERAL_DOCUMENT_EDITOR_ID,
	name: localize('document.editor', 'Document'),
	documentType: { id: 'general', contentType: GENERAL_DOCUMENT_CONTENT_TYPE, extensions: ['.ash-doc'] },
	canOpen: input => {
		if (isDiffEditorInput(input)) return EditorPaneMatch.None;
		const matches = input.contentType === GENERAL_DOCUMENT_CONTENT_TYPE || input.resource.path.toLowerCase().endsWith('.ash-doc');
		return matches ? EditorPaneMatch.Default : EditorPaneMatch.None;
	},
	create: options => createDocumentEditorPane(generalProfile, options),
});

registerAction2(class NewDocumentAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.document.new', title: localize2('document.new', 'New Document'), f1: true, menu: { id: MenuId.MenubarFileMenu, group: '1_file', order: -0.5 } });
	}
	override run(accessor: ServicesAccessor): Promise<void> { return createGeneralDocument(accessor); }
});

for (const format of ['text', 'markdown'] as const) {
	registerAction2(class ConvertToDocumentAction extends Action2 {
		constructor() {
			super({
				id: `workbench.action.document.import.${format}`, title: format === 'markdown'
					? localize2('document.importMarkdown', 'Convert Active Markdown to Document')
					: localize2('document.importText', 'Convert Active Text to Document'), f1: true
			});
		}
		override run(accessor: ServicesAccessor): Promise<void> { return convertActiveTextToDocument(accessor, format); }
	});
	registerAction2(class ExportDocumentAction extends Action2 {
		constructor() {
			super({
				id: `workbench.action.document.export.${format}`, title: format === 'markdown'
					? localize2('document.exportMarkdown', 'Export Document as Markdown')
					: localize2('document.exportText', 'Export Document as Plain Text'), f1: true
			});
		}
		override run(accessor: ServicesAccessor): Promise<void> { return exportActiveDocument(accessor, format); }
	});
}
