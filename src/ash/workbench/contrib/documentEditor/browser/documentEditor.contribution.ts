import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { createGeneralDocument, convertActiveTextToDocument, exportActiveDocument, exportDocumentArtifact, importDocumentArtifact } from './documentActions.js';
import './documentAccessibility.js';

registerAction2(
	class NewDocumentAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.document.new',
				title: localize2('document.new', 'New Document'),
				f1: true,
				menu: { id: MenuId.MenubarFileMenu, group: '1_file', order: -0.5 },
			});
		}
		override run(accessor: ServicesAccessor): Promise<void> {
			return createGeneralDocument(accessor);
		}
	},
);

for (const format of ['text', 'markdown'] as const) {
	registerAction2(
		class ConvertToDocumentAction extends Action2 {
			constructor() {
				super({
					id: `workbench.action.document.import.${format}`,
					title: format === 'markdown' ? localize2('document.importMarkdown', 'Convert Active Markdown to Document') : localize2('document.importText', 'Convert Active Text to Document'),
					f1: true,
				});
			}
			override run(accessor: ServicesAccessor): Promise<void> {
				return convertActiveTextToDocument(accessor, format);
			}
		},
	);
	registerAction2(
		class ExportDocumentAction extends Action2 {
			constructor() {
				super({
					id: `workbench.action.document.export.${format}`,
					title: format === 'markdown' ? localize2('document.exportMarkdown', 'Export Document as Markdown') : localize2('document.exportText', 'Export Document as Plain Text'),
					f1: true,
				});
			}
			override run(accessor: ServicesAccessor): Promise<void> {
				return exportActiveDocument(accessor, format);
			}
		},
	);
}

for (const operation of ['import', 'export'] as const)
	registerAction2(
		class DocumentArtifactAction extends Action2 {
			constructor() {
				super({
					id: `workbench.action.document.${operation}.file`,
					title: operation === 'import' ? localize2('document.output.import', 'Import Document File…') : localize2('document.output.export', 'Export Document File…'),
					f1: true,
					menu: { id: MenuId.MenubarFileMenu, group: '2_files', order: operation === 'import' ? 10 : 11 },
				});
			}
			override run(accessor: ServicesAccessor): Promise<void> {
				return operation === 'import' ? importDocumentArtifact(accessor) : exportDocumentArtifact(accessor);
			}
		},
	);
