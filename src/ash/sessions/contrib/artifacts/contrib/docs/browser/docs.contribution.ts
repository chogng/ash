import { URI } from '../../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../../../platform/contextkey/common/contextkey.js';
import { OPEN_EXTENSIONS_COMMAND_ID } from '../../../../../../platform/extensionManagement/common/extensionManagementService.js';
import type { ServicesAccessor } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { EditorPanes } from '../../../../../../workbench/browser/editor.js';
import { IEditorPart } from '../../../../../../workbench/browser/parts/editor/editorPart.js';
import { ActiveEditorContext } from '../../../../../../workbench/common/contextkeys.js';
import { DocumentEditorPane } from '../../../../../../workbench/contrib/documentEditor/browser/documentEditorPane.js';
import { DocumentTypes } from '../../../../../../workbench/services/documentEditor/common/documentTypes.js';
import { IExtensionRecommendationsService } from '../../../../../../workbench/services/extensionRecommendations/common/extensionRecommendations.js';
import { ISessionsLayoutService } from '../../../../../services/layout/common/sessionsLayoutService.js';
import { DOCS_EDITOR_SETTING, GENERAL_DOCUMENT_CONTENT_TYPE, type DocsEditorPreference } from '../common/docs.js';
import { convertActiveTextToDocument, createGeneralDocument, exportActiveDocument, exportDocumentArtifact, importDocumentArtifact } from './documentActions.js';

DocumentTypes.enableFileEditors();

function createDocumentOpener(accessor: ServicesAccessor): (resource: URI, source?: 'restore') => Promise<void> {
	const editors = accessor.get(IEditorPart);
	const storage = accessor.get(IStorageService);
	const layout = accessor.get(ISessionsLayoutService);
	return (resource, source) => {
		const input = editors.groups.flatMap(group => group.editors.map(editor => editor.input)).find(input => input.resource.toString() === resource.toString())
			?? {
			resource,
			...(resource.scheme === 'untitled' ? { initialText: '' } : {}),
			...(resource.path.endsWith('.ash-doc') ? { contentType: GENERAL_DOCUMENT_CONTENT_TYPE } : { languageId: 'markdown', contentType: 'text/markdown' }),
		};
		storage.store('sessions.creator.activeDocument', resource.toString(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		return layout.openEntry({
			id: 'creator.docs', workspaceMode: 'current', activityContext: 'sessions.activity.creatorSelected', content: 'editor',
			editorInput: input, restoreCommand: 'sessions.restore.creatorDocs', focus: 'editor',
		}, undefined, source ? { source } : undefined);
	};
}

function hasRichDocumentEditor(): boolean {
	return EditorPanes.getEditorPanesForInput({ resource: URI.parse('untitled:/document.ash-doc'), contentType: GENERAL_DOCUMENT_CONTENT_TYPE })
		.some(pane => pane.resolveDocumentProfile !== undefined);
}

function recommendRichDocuments(accessor: ServicesAccessor): void {
	accessor.get(IExtensionRecommendationsService).recommendForResource(URI.parse('untitled:/document.ash-doc'));
}

CommandsRegistry.register('sessions.creator.newDocument', accessor => {
	// Rich document providers are optional. The built-in Markdown editor also owns real drafts and saves.
	const richDocuments = hasRichDocumentEditor();
	const preference = accessor.get(IConfigurationService).getValue<DocsEditorPreference>(DOCS_EDITOR_SETTING) ?? 'automatic';
	const useRich = preference !== 'markdown' && !!richDocuments;
	if (preference !== 'markdown' && !richDocuments) { recommendRichDocuments(accessor); }
	return createDocumentOpener(accessor)(URI.from({
		scheme: 'untitled', path: `/${generateUuid()}/${localize('sessions.artifacts.untitledDocument', 'Untitled document')}.${useRich ? 'ash-doc' : 'md'}`,
	}));
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<DocsEditorPreference>({
	key: DOCS_EDITOR_SETTING, scope: ConfigurationScope.APPLICATION, defaultValue: 'automatic',
	parse(value: unknown): DocsEditorPreference {
		if (value !== 'automatic' && value !== 'rich' && value !== 'markdown') { throw new TypeError(localize('sessions.artifacts.invalidEditor', 'Choose Automatic, Rich document or Markdown for Docs.')); }
		return value;
	},
	setting: {
		valueType: 'select', title: localize('sessions.artifacts.docsEditor', 'Docs editor'),
		description: localize('sessions.artifacts.docsEditorDescription', 'Choose how to create Docs. Automatic uses an available rich document extension and otherwise opens Markdown.'),
		options: [
			{ value: 'automatic', label: localize('sessions.artifacts.automatic', 'Automatic') },
			{ value: 'rich', label: localize('sessions.artifacts.rich', 'Rich document') },
			{ value: 'markdown', label: localize('sessions.artifacts.markdown', 'Markdown') },
		],
	},
});

registerAction2(class ChooseDocsEditor extends Action2 {
	constructor() { super({ id: 'sessions.creator.chooseDocsEditor', title: localize2('sessions.artifacts.chooseEditor', 'Choose Docs editor'), f1: true }); }
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const configuration = accessor.get(IConfigurationService);
		const commands = accessor.get(ICommandService);
		const current = configuration.getValue<DocsEditorPreference>(DOCS_EDITOR_SETTING) ?? 'automatic';
		const richAvailable = hasRichDocumentEditor();
		using store = new DisposableStore();
		const picker = store.add(accessor.get(IQuickInputService).createQuickPick<{ readonly id: DocsEditorPreference | 'extensions' | 'blank'; readonly label: string; readonly detail?: string; readonly picked?: boolean; }>());
		picker.placeholder = picker.ariaLabel = localize('sessions.artifacts.chooseEditor', 'Choose Docs editor');
		picker.items = [
			{ id: 'automatic', label: localize('sessions.artifacts.automatic', 'Automatic'), picked: current === 'automatic', detail: localize('sessions.artifacts.automaticDetail', 'Use a rich document extension when available, otherwise Markdown.') },
			{ id: 'rich', label: localize('sessions.artifacts.rich', 'Rich document'), picked: current === 'rich', detail: richAvailable ? undefined : localize('sessions.artifacts.richUnavailable', 'Requires a rich document extension. Markdown stays available while you install one.') },
			{ id: 'markdown', label: localize('sessions.artifacts.markdown', 'Markdown'), picked: current === 'markdown' },
			{ id: 'extensions', label: localize('sessions.artifacts.findRichEditor', 'Find rich document extensions') },
			{ id: 'blank', label: localize('sessions.artifacts.newBlankDocument', 'New blank document') },
		];
		const selected = await new Promise<DocsEditorPreference | 'extensions' | 'blank' | undefined>(resolve => {
			store.add(picker.onDidAccept(() => { resolve(picker.selectedItems[0]?.id); picker.hide(); }));
			store.add(picker.onDidHide(() => resolve(undefined)));
			picker.show();
		});
		if (!selected) { return; }
		if (selected === 'blank') { await commands.executeCommand('sessions.creator.newDocument'); return; }
		if (selected === 'extensions') { await commands.executeCommand(OPEN_EXTENSIONS_COMMAND_ID, { mode: 'browse', query: 'academy' }); return; }
		await configuration.updateValue(DOCS_EDITOR_SETTING, selected, ConfigurationTarget.USER_LOCAL);
	}
});

registerAction2(class SwitchDocsEditor extends Action2 {
	constructor() {
		super({
			id: 'sessions.creator.switchDocsEditor', title: localize2('sessions.artifacts.switchEditor', 'Switch Docs editor'), f1: true,
			menu: { id: MenuId.EditorTitle, group: 'navigation', order: 20, when: ContextKeyExpr.or(ActiveEditorContext.isEqualTo('ash.editor.document'), ContextKeyExpr.equals('resourceExtname', '.md')) },
		});
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const editors = accessor.get(IEditorPart);
		const commands = accessor.get(ICommandService);
		const openConverted = createDocumentOpener(accessor);
		const source = editors.activeInput;
		if (!source) { return; }
		const rich = editors.activePane instanceof DocumentEditorPane;
		if (!rich && !source.resource.path.endsWith('.md')) { return; }
		if (!rich && !hasRichDocumentEditor()) {
			recommendRichDocuments(accessor);
			await commands.executeCommand(OPEN_EXTENSIONS_COMMAND_ID, { mode: 'browse', query: 'academy' });
			return;
		}
		await commands.executeCommand(rich ? 'workbench.action.document.export.markdown' : 'workbench.action.document.import.markdown');
		const converted = editors.activeInput;
		if (converted && converted !== source) { await openConverted(converted.resource); }
	}
});
CommandsRegistry.register('sessions.creator.openDocument', (accessor, value) => {
	// Card targets must still belong to a retained document editor.
	const input = accessor.get(IEditorPart).groups.flatMap(group => group.editors.map(editor => editor.input)).find(input =>
		input.resource.toString() === value && (input.contentType === GENERAL_DOCUMENT_CONTENT_TYPE || input.resource.path.endsWith('.md')));
	if (!input) { throw new TypeError(localize('sessions.artifacts.unavailableDocument', 'This document is no longer open.')); }
	return createDocumentOpener(accessor)(input.resource);
});
CommandsRegistry.register('sessions.restore.creatorDocs', (accessor, source) => {
	const saved = accessor.get(IStorageService).get('sessions.creator.activeDocument', StorageScope.WORKSPACE);
	if (!saved) { return accessor.get(ICommandService).executeCommand('sessions.show.creator', source); }
	const resource = URI.parse(saved);
	if (!['file', 'untitled'].includes(resource.scheme) || !/\.(?:ash-doc|md)$/u.test(resource.path)) { return accessor.get(ICommandService).executeCommand('sessions.show.creator', source); }
	return createDocumentOpener(accessor)(resource, source === 'restore' ? source : undefined);
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

for (const operation of ['import', 'export'] as const) registerAction2(class DocumentArtifactAction extends Action2 {
	constructor() { super({ id: `workbench.action.document.${operation}.file`, title: operation === 'import' ? localize2('document.output.import', 'Import Document File…') : localize2('document.output.export', 'Export Document File…'), f1: true, menu: { id: MenuId.MenubarFileMenu, group: '2_files', order: operation === 'import' ? 10 : 11 } }); }
	override run(accessor: ServicesAccessor): Promise<void> { return operation === 'import' ? importDocumentArtifact(accessor) : exportDocumentArtifact(accessor); }
});
