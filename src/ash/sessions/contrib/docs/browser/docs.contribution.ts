import { Schemas } from '../../../../base/common/network.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IGeneratedFilesService } from '../../../services/generatedFiles/common/generatedFilesService.js';
import { isRetainedDocsInput } from './docsArtifactCatalog.js';
import { URI } from '../../../../base/common/uri.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import type { EditorPaneOptions as TextEditorPaneOptions } from '../../../../workbench/browser/parts/editor/textResourceEditor.js';
import { isResourceDiffEditorInput } from '../../../../workbench/common/editor.js';
import { createBrowserEditorPart } from '../../../../workbench/contrib/codeEditor/browser/browserEditorPart.js';
import { getBrowserTextResourceStore } from '../../../../workbench/contrib/codeEditor/browser/browserTextResourceStore.js';
import { TextFileSaveErrorHandler } from '../../../../workbench/contrib/files/browser/editors/textFileSaveErrorHandler.js';
import { ViewContainerLocation, type IView } from '../../../../workbench/common/views.js';
import { EDIT_CHAT_WRITING_COMMAND_ID } from '../../../../workbench/contrib/chat/common/model/chatMarkdownRichContent.js';
import { DocumentTypes } from '../../../../workbench/services/documentEditor/common/documentTypes.js';
import { SessionsViewRegistry } from '../../../common/views.js';
import { DOCS_ARTIFACT_EDITOR_ID, DOCS_EDITOR_SETTING, DOCS_MARKDOWN_EDITOR_ID, DOCS_TOOLS_CONTAINER_ID, GENERAL_DOCUMENT_CONTENT_TYPE, GENERAL_DOCUMENT_EDITOR_ID, type DocsEditorPreference } from '../common/docs.js';
import { convertActiveTextToDocument, createDocsInput, createDocsOpener, createGeneralDocument, createMarkdownDocsInput, exportActiveDocument, exportDocumentArtifact, importDocumentArtifact, newDocsResource, openWritingDraft, restoredDocsResource } from './documentActions.js';
import { DocsArtifactPane, DocsToolsView } from './docsArtifactPane.js';
import { MarkdownDocsArtifactPane } from './markdownDocsArtifactPane.js';

DocumentTypes.enableFileEditors();

registerWorkbenchContribution('sessions.generatedFileOpener', WorkbenchPhase.BlockRestore, accessor => {
	const generated = accessor.get(IGeneratedFilesService);
	const open = createDocsOpener(accessor);
	return accessor.get(IOpenerService).registerOpener({
		open: async (target, options) => {
			if (options?.openExternal) return false;
			const resource = typeof target === 'string' ? URI.parse(target) : target;
			if (!generated.isProfileGeneratedPath(resource) && !generated.isGeneratedResource(resource)) return false;
			await generated.refresh();
			const file = generated.files.find(file => file.resource.toString() === resource.toString());
			if (!file) throw new Error(localize({ bundle: 'ash.artifacts', key: 'generatedFileUnavailable' }, 'This generated file is unavailable.'));
			await open(file.resource, { label: file.title });
			return true;
		}
	});
});

const resolveDocumentProfile = async () => (await import('../../../../../../extensions/academy/browser/generalProfile.js')).generalProfile;
registerEditorPane({
	id: GENERAL_DOCUMENT_EDITOR_ID,
	get name() { return localize('sessions.artifacts.rich', 'Rich document'); },
	documentType: { id: 'general', contentType: GENERAL_DOCUMENT_CONTENT_TYPE, extensions: ['.ash-doc'] },
	canOpen: input => !isResourceDiffEditorInput(input) &&
		(input.contentType?.split(';', 1)[0].trim().toLowerCase() === GENERAL_DOCUMENT_CONTENT_TYPE || input.resource.path.toLowerCase().endsWith('.ash-doc'))
		? EditorPaneMatch.Builtin : EditorPaneMatch.None,
	resolveDocumentProfile,
	async create(options) {
		const [{ createDocumentEditorPane }, profile] = await Promise.all([
			import('../../../../workbench/contrib/documentEditor/browser/editorProfile.js'),
			resolveDocumentProfile(),
		]);
		return createDocumentEditorPane(profile, options);
	},
});

registerEditorPane({
	id: DOCS_ARTIFACT_EDITOR_ID,
	get name() { return localize('sessions.artifacts.docs', 'Docs'); },
	canOpen: input => !isResourceDiffEditorInput(input) && input.editorId === DOCS_ARTIFACT_EDITOR_ID && input.contentType === GENERAL_DOCUMENT_CONTENT_TYPE
		? EditorPaneMatch.Default : EditorPaneMatch.None,
	createInput: createDocsInput,
	resolveDocumentProfile,
	async create(options) {
		const [{ resolveDocumentPaneOptions }, { artifactDocumentProfile }] = await Promise.all([
			import('../../../../workbench/contrib/documentEditor/browser/editorProfile.js'),
			import('../../../../../../extensions/academy/browser/generalProfile.js'),
		]);
		return options.instantiationService!.createInstance(DocsArtifactPane, resolveDocumentPaneOptions({ ...artifactDocumentProfile, editorId: DOCS_ARTIFACT_EDITOR_ID }, options));
	},
});

registerEditorPane({
	id: DOCS_MARKDOWN_EDITOR_ID,
	get name() { return localize('sessions.artifacts.markdown', 'Markdown'); },
	canOpen: input => input.editorId === DOCS_MARKDOWN_EDITOR_ID && !isResourceDiffEditorInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None,
	createInput: createMarkdownDocsInput,
	create(options) {
		const { instantiationService, textFileService } = options;
		if (!instantiationService || !textFileService) throw new Error('Docs Markdown requires the Workbench text file service');
		const saveErrors = instantiationService.createInstance(TextFileSaveErrorHandler);
		return instantiationService.createInstance(MarkdownDocsArtifactPane, getBrowserTextResourceStore(textFileService), {
			createPart: partOptions => createBrowserEditorPart(instantiationService, partOptions),
			workingCopyService: options.workingCopyService,
			accessibilityService: options.accessibilityService,
			onSave: options.onSave,
			onSaveError: (error, resource) => saveErrors.onSaveError(error, resource),
		} satisfies TextEditorPaneOptions);
	},
});

const docsToolsTitle = { title: 'Document tools', localizationKey: { bundle: 'ash.docs', key: 'tools' } };
SessionsViewRegistry.registerStaticViewContainer({ id: DOCS_TOOLS_CONTAINER_ID, ...docsToolsTitle, location: ViewContainerLocation.AuxiliaryBar });
SessionsViewRegistry.registerStaticViews(DOCS_TOOLS_CONTAINER_ID, [{
	id: `${DOCS_TOOLS_CONTAINER_ID}.view`, ...docsToolsTitle, ctorDescriptor: new SyncDescriptor<IView>(DocsToolsView), canToggleVisibility: false,
}]);

CommandsRegistry.register(EDIT_CHAT_WRITING_COMMAND_ID, (accessor, html, title) => {
	if (typeof html !== 'string' || title !== undefined && typeof title !== 'string') {
		throw new TypeError(localize('sessions.artifacts.writingImportFailed', 'This writing block could not be opened in Docs.'));
	}
	return openWritingDraft(accessor, html, title);
});

CommandsRegistry.register('sessions.creator.newDocument', accessor => {
	const preference = accessor.get(IConfigurationService).getValue<DocsEditorPreference>(DOCS_EDITOR_SETTING);
	return createDocsOpener(accessor)(newDocsResource(localize('sessions.artifacts.untitledDocument', 'Untitled document'), preference === 'markdown' ? '.md' : '.ash-doc'));
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<DocsEditorPreference>({
	key: DOCS_EDITOR_SETTING, scope: ConfigurationScope.APPLICATION, defaultValue: 'rich',
	parse(value: unknown): DocsEditorPreference {
		if (value === 'automatic') return 'rich';
		if (value !== 'rich' && value !== 'markdown') { throw new TypeError(localize('sessions.artifacts.invalidEditor', 'Choose Rich document or Markdown for Docs.')); }
		return value;
	},
	setting: {
		valueType: 'select', title: localize('sessions.artifacts.docsEditor', 'Docs editor'),
		description: localize('sessions.artifacts.docsEditorDescription', 'Choose whether new Docs open as a rich document or a Markdown file.'),
		options: [
			{ value: 'rich', label: localize('sessions.artifacts.rich', 'Rich document') },
			{ value: 'markdown', label: localize('sessions.artifacts.markdown', 'Markdown') },
		],
	},
});

const chatWorkspace = ContextKeyExpr.notEquals(SessionsWorkspaceModeContext.key, 'code');

registerAction2(class ChooseDocsEditor extends Action2 {
	constructor() { super({ id: 'sessions.creator.chooseDocsEditor', title: localize2('sessions.artifacts.chooseEditor', 'Choose Docs editor'), f1: true, precondition: chatWorkspace }); }
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const contextKeys = accessor.get(IContextKeyService);
		if (!contextKeys.contextMatchesRules(chatWorkspace)) return;
		const configuration = accessor.get(IConfigurationService);
		const commands = accessor.get(ICommandService);
		const current = configuration.getValue<DocsEditorPreference>(DOCS_EDITOR_SETTING) ?? 'rich';
		using store = new DisposableStore();
		const picker = store.add(accessor.get(IQuickInputService).createQuickPick<{ readonly id: DocsEditorPreference | 'blank'; readonly label: string; readonly picked?: boolean; }>());
		picker.placeholder = picker.ariaLabel = localize('sessions.artifacts.chooseEditor', 'Choose Docs editor');
		picker.items = [
			{ id: 'rich', label: localize('sessions.artifacts.rich', 'Rich document'), picked: current === 'rich' },
			{ id: 'markdown', label: localize('sessions.artifacts.markdown', 'Markdown'), picked: current === 'markdown' },
			{ id: 'blank', label: localize('sessions.artifacts.newBlankDocument', 'New blank document') },
		];
		const selected = await new Promise<DocsEditorPreference | 'blank' | undefined>(resolve => {
			store.add(picker.onDidAccept(() => { resolve(picker.selectedItems[0]?.id); picker.hide(); }));
			store.add(picker.onDidHide(() => resolve(undefined)));
			picker.show();
		});
		if (!selected || !contextKeys.contextMatchesRules(chatWorkspace)) { return; }
		if (selected === 'blank') { await commands.executeCommand('sessions.creator.newDocument'); return; }
		await configuration.updateValue(DOCS_EDITOR_SETTING, selected, ConfigurationTarget.USER_LOCAL);
	}
});

CommandsRegistry.register('sessions.creator.openDocument', (accessor, value) => {
	// Card targets must still belong to a retained document editor.
	const generated = accessor.get(IGeneratedFilesService);
	const input = accessor.get(IEditorPart).groups.flatMap(group => group.editors.map(editor => editor.input)).find(input =>
		input.resource.toString() === value && isRetainedDocsInput(input, generated));
	if (!input) { throw new TypeError(localize('sessions.artifacts.unavailableDocument', 'This document is no longer open.')); }
	return createDocsOpener(accessor)(input.resource);
});
CommandsRegistry.register('sessions.restore.creatorDocs', async (accessor, source) => {
	const resource = restoredDocsResource(accessor.get(IStorageService));
	const commands = accessor.get(ICommandService);
	if (!resource) return commands.executeCommand('sessions.show.creator', source);
	const open = createDocsOpener(accessor);
	if (resource.scheme === Schemas.vscodeUserData) {
		const generated = accessor.get(IGeneratedFilesService);
		if (generated.isProfileGeneratedPath(resource)) {
			await generated.refresh().catch(() => undefined);
			const file = generated.files.find(file => file.resource.toString() === resource.toString());
			if (!file) return commands.executeCommand('sessions.show.creator', source);
			return open(resource, { label: file.title, source: source === 'restore' ? source : undefined });
		}
	}
	return open(resource, { source: source === 'restore' ? source : undefined });
});

registerAction2(class NewDocumentAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.document.new', title: localize2('document.new', 'New Document'), f1: true, precondition: chatWorkspace, menu: { id: MenuId.MenubarFileMenu, when: chatWorkspace, group: '1_file', order: -0.5 } });
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		if (accessor.get(IContextKeyService).contextMatchesRules(chatWorkspace)) await createGeneralDocument(accessor);
	}
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
	constructor() {
		const importing = operation === 'import';
		const when = importing ? chatWorkspace : undefined;
		super({
			id: `workbench.action.document.${operation}.file`,
			title: importing ? localize2('document.output.import', 'Import Document File…') : localize2('document.output.export', 'Export Document File…'),
			f1: true,
			precondition: when,
			menu: { id: MenuId.MenubarFileMenu, when, group: '2_files', order: importing ? 10 : 11 },
		});
	}
	override async run(accessor: ServicesAccessor, format?: unknown): Promise<void> {
		if (operation === 'import') {
			if (accessor.get(IContextKeyService).contextMatchesRules(chatWorkspace)) await importDocumentArtifact(accessor);
		} else {
			await exportDocumentArtifact(accessor, typeof format === 'string' ? format : undefined);
		}
	}
});
