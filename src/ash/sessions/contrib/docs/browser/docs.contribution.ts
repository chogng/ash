import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IDocsService } from '../common/docsService.js';
import { DocsService } from './docsService.js';
import './arkdown/arkdown.contribution.js';
import { Schemas } from '../../../../base/common/network.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IArtifactCatalogService } from '../../../services/artifactCatalog/common/artifactCatalogService.js';
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
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { isResourceDiffEditorInput } from '../../../../workbench/common/editor.js';
import { CODE_EDITOR_ID } from '../../../../workbench/common/editor/codeEditorId.js';
import { EDIT_CHAT_WRITING_COMMAND_ID } from '../../../../workbench/contrib/chat/common/model/chatMarkdownRichContent.js';
import { DocumentTypes } from '../../../../workbench/services/documentEditor/common/documentTypes.js';
import { DOCS_DEFAULT_MODE_SETTING, DOCS_ARKDOWN_EDITOR_ID, LEGACY_DOCS_CONTENT_TYPE, LEGACY_DOCS_FILE_EDITOR_ID, LEGACY_DOCS_EDITOR_ID, type DocsEditorMode } from '../common/docs.js';
import { convertActiveTextToDocument, createDocsOpener, createDocsDocument, exportActiveDocument, exportDocumentArtifact, importDocumentArtifact, openWritingDraft, restoredDocsResource } from './documentActions.js';
import { createArkdownDocsInput } from './docsEditorInput.js';
import { migrateLegacyDocsInput } from './legacyDocsMigration.js';
import { ArkdownDocsEditorPane } from './arkdownDocsEditorPane.js';
import { createDocsBackupContribution } from './docsBackupContribution.js';

registerSingleton(IDocsService, DocsService, InstantiationType.Delayed);

DocumentTypes.enableFileEditors();

registerWorkbenchContribution('sessions.docs.backup', WorkbenchPhase.BlockRestore, createDocsBackupContribution);

registerWorkbenchContribution('sessions.docs.resourceOpener', WorkbenchPhase.BlockRestore, accessor => {
	const generated = accessor.get(IArtifactCatalogService);
	const docs = accessor.get(IDocsService);
	const open = createDocsOpener(accessor);
	const contextKeys = accessor.get(IContextKeyService);
	return accessor.get(IOpenerService).registerOpener({
		open: async (target, options) => {
			if (options?.openExternal) return false;
			const resource = typeof target === 'string' ? URI.parse(target) : target;
			if (!docs.isProfileDocumentPath(resource) && !generated.hasResource(resource)) return false;
			await generated.refresh();
			const file = generated.files.find(file => file.resource.toString() === resource.toString());
			if (!file) throw new Error(localize({ bundle: 'ash.artifacts', key: 'artifactUnavailable' }, 'This artifact is unavailable.'));
			if (file.contentType !== 'text/markdown' && file.contentType !== LEGACY_DOCS_CONTENT_TYPE) return false;
			// Resolve the current presentation after the account-scoped catalog refresh.
			if (contextKeys.getValue(SessionsWorkspaceModeContext.key) === 'code') return false;
			await open(file.resource, { label: file.title });
			return true;
		}
	});
});

for (const id of [LEGACY_DOCS_FILE_EDITOR_ID, LEGACY_DOCS_EDITOR_ID]) registerEditorPane({
	id,
	get name() { return localize({ bundle: 'ash.docs', key: 'legacyDocument' }, 'Legacy document'); },
	canOpen: input => {
		if (isResourceDiffEditorInput(input)) return EditorPaneMatch.None;
		const matchesLegacyFile = id === LEGACY_DOCS_FILE_EDITOR_ID && input.editorId !== LEGACY_DOCS_EDITOR_ID
			&& (/\.ash-doc$/iu.test(input.resource.path) || input.contentType === LEGACY_DOCS_CONTENT_TYPE);
		return input.editorId === id || matchesLegacyFile ? EditorPaneMatch.Builtin : EditorPaneMatch.None;
	},
	async resolveInput(input, accessor) {
		const migrated = await migrateLegacyDocsInput(input, accessor);
		// Ordinary files retain the Code workflow. Explicit legacy Docs retains its product host.
		return input.editorId === LEGACY_DOCS_EDITOR_ID ? migrated
			: { ...migrated, editorId: CODE_EDITOR_ID, rename: undefined, showBreadcrumbs: input.showBreadcrumbs };
	},
	create() { throw new Error('Legacy Docs must resolve to Arkdown before pane creation'); },
});

registerEditorPane({
	id: DOCS_ARKDOWN_EDITOR_ID,
	get name() { return localize('sessions.artifacts.docs', 'Docs'); },
	canOpen: input => input.editorId === DOCS_ARKDOWN_EDITOR_ID && !isResourceDiffEditorInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None,
	createInput: createArkdownDocsInput,
	create(options) {
		if (!options.instantiationService) throw new Error('Docs requires the Workbench instantiation service');
		return options.instantiationService.createInstance(ArkdownDocsEditorPane, options.onSave);
	},
});

CommandsRegistry.register(EDIT_CHAT_WRITING_COMMAND_ID, (accessor, html, title) => {
	if (typeof html !== 'string' || title !== undefined && typeof title !== 'string') {
		throw new TypeError(localize('sessions.artifacts.writingImportFailed', 'This writing block could not be opened in Docs.'));
	}
	return openWritingDraft(accessor, html, title);
});

CommandsRegistry.register('sessions.docs.newDocument', accessor => {
	return createDocsDocument(accessor, localize('sessions.artifacts.untitledDocument', 'Untitled document'));
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<DocsEditorMode>({
	key: DOCS_DEFAULT_MODE_SETTING, scope: ConfigurationScope.APPLICATION, defaultValue: 'rich',
	parse(value: unknown): DocsEditorMode {
		if (value === 'automatic') return 'rich';
		if (value !== 'rich' && value !== 'markdown') { throw new TypeError(localize({ bundle: 'ash.docs', key: 'invalidMode' }, 'Choose Document or Markdown source for Docs.')); }
		return value;
	},
	setting: {
		valueType: 'select', title: localize({ bundle: 'ash.docs', key: 'defaultMode' }, 'Default Docs view'),
		description: localize({ bundle: 'ash.docs', key: 'defaultModeDescription' }, 'Choose the default view for Markdown Docs.'),
		options: [
			{ value: 'rich', label: localize({ bundle: 'ash.docs', key: 'formattedView' }, 'Document') },
			{ value: 'markdown', label: localize({ bundle: 'ash.docs', key: 'sourceView' }, 'Markdown source') },
		],
	},
});

const chatWorkspace = ContextKeyExpr.notEquals(SessionsWorkspaceModeContext.key, 'code');

registerAction2(class ChooseDocsMode extends Action2 {
	constructor() { super({ id: 'sessions.docs.chooseEditor', title: localize2({ bundle: 'ash.docs', key: 'chooseMode' }, 'Choose default Docs view'), f1: true, precondition: chatWorkspace }); }
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const contextKeys = accessor.get(IContextKeyService);
		if (!contextKeys.contextMatchesRules(chatWorkspace)) return;
		const configuration = accessor.get(IConfigurationService);
		const commands = accessor.get(ICommandService);
		const current = configuration.getValue<DocsEditorMode>(DOCS_DEFAULT_MODE_SETTING) ?? 'rich';
		using store = new DisposableStore();
		const picker = store.add(accessor.get(IQuickInputService).createQuickPick<{ readonly id: DocsEditorMode | 'blank'; readonly label: string; readonly picked?: boolean; }>());
		picker.placeholder = picker.ariaLabel = localize({ bundle: 'ash.docs', key: 'chooseMode' }, 'Choose default Docs view');
		picker.items = [
			{ id: 'rich', label: localize({ bundle: 'ash.docs', key: 'formattedView' }, 'Document'), picked: current === 'rich' },
			{ id: 'markdown', label: localize({ bundle: 'ash.docs', key: 'sourceView' }, 'Markdown source'), picked: current === 'markdown' },
			{ id: 'blank', label: localize('sessions.artifacts.newBlankDocument', 'New blank document') },
		];
		const selected = await new Promise<DocsEditorMode | 'blank' | undefined>(resolve => {
			store.add(picker.onDidAccept(() => { resolve(picker.selectedItems[0]?.id); picker.hide(); }));
			store.add(picker.onDidHide(() => resolve(undefined)));
			picker.show();
		});
		if (!selected || !contextKeys.contextMatchesRules(chatWorkspace)) { return; }
		if (selected === 'blank') { await commands.executeCommand('sessions.docs.newDocument'); return; }
		await configuration.updateValue(DOCS_DEFAULT_MODE_SETTING, selected, ConfigurationTarget.USER_LOCAL);
	}
});

CommandsRegistry.register('sessions.docs.openDocument', (accessor, value) => {
	// Card targets must still belong to a retained document editor.
	const generated = accessor.get(IArtifactCatalogService);
	const input = accessor.get(IEditorPart).groups.flatMap(group => group.editors.map(editor => editor.input)).find(input =>
		input.resource.toString() === value && isRetainedDocsInput(input, generated, accessor.get(IDocsService)));
	if (!input) { throw new TypeError(localize('sessions.artifacts.unavailableDocument', 'This document is no longer open.')); }
	return createDocsOpener(accessor)(input.resource);
});
CommandsRegistry.register('sessions.restore.docs', async (accessor, source) => {
	const resource = restoredDocsResource(accessor.get(IStorageService));
	const commands = accessor.get(ICommandService);
	if (!resource) return commands.executeCommand('sessions.show.artifacts', source);
	const open = createDocsOpener(accessor);
	if (resource.scheme === Schemas.vscodeUserData) {
		const generated = accessor.get(IArtifactCatalogService);
		if (accessor.get(IDocsService).isProfileDocumentPath(resource)) {
			await generated.refresh().catch(() => undefined);
			const file = generated.files.find(file => file.resource.toString() === resource.toString());
			if (!file) return commands.executeCommand('sessions.show.artifacts', source);
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
		if (accessor.get(IContextKeyService).contextMatchesRules(chatWorkspace)) await createDocsDocument(accessor);
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
