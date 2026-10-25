import { getActiveElement } from '../../../../base/browser/dom.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { ISessionsLayoutService, type ISessionsEntry } from '../../../services/layout/common/sessionsLayoutService.js';
import { CreatorMode, DOCS_EDITOR_SETTING, type DocsEditorPreference } from '../common/creator.js';
import { DESIGN_LAYERS_CONTAINER_ID, DESIGN_PROPERTIES_CONTAINER_ID } from './designEditorService.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IExtensionRecommendationsService } from '../../../../workbench/services/extensionRecommendations/common/extensionRecommendations.js';
import { OPEN_EXTENSIONS_COMMAND_ID } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { Menus } from '../../../browser/menus.js';
import { CreatorPage, CreatorEditorPane } from './creatorPage.js';
import { GENERAL_DOCUMENT_CONTENT_TYPE } from '../../../../workbench/contrib/documentEditor/browser/documentEditorInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { ViewContainerLocation } from '../../../../workbench/common/views.js';
import { EditorPanes, registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { DocumentEditorPane } from '../../../../workbench/contrib/documentEditor/browser/documentEditorPane.js';
import { ActiveEditorContext } from '../../../../workbench/common/contextkeys.js';

registerEditorPane({ id: 'sessions.editor.creator', name: 'Artifacts', canOpen: input => input.resource.scheme === 'ash-creator' && input.resource.path === '/page' ? EditorPaneMatch.Default : EditorPaneMatch.None, create: options => options.instantiationService!.createInstance(CreatorEditorPane) });

function openCreator(accessor: ServicesAccessor, workspace?: CreatorMode | 'home', source?: 'restore'): Promise<void> {
	const editor = accessor.get(IEditorPart);
	const navigation = accessor.get(IViewsService).getVisibleViewContainer(ViewContainerLocation.Sidebar)?.id;
	const entry: ISessionsEntry = {
		id: 'creator.home', activityContext: 'sessions.activity.creatorSelected', content: 'editor',
		showEditorTabs: false, restoreCommand: 'sessions.restore.creator', focus: 'editor',
		editorInput: {
			resource: URI.from({ scheme: 'ash-creator', path: '/page' }), label: localize('sessions.creator.title', 'Artifacts'),
			showBreadcrumbs: false, readOnly: true, capabilities: EditorInputCapabilities.CannotClose,
		},
	};
	return accessor.get(ISessionsLayoutService).openEntry(entry, () => {
		const page = (editor.activePane as CreatorEditorPane).page;
		if (navigation && navigation !== DESIGN_LAYERS_CONTAINER_ID) { page.navigationContainerId = navigation; }
		if (workspace === 'home') { page.showHome(); }
		else if (workspace) { page.openMode(workspace); }
		return page.usesCanvasPanels ? {
			...entry, id: page.activeMode === CreatorMode.Design ? 'creator.design' : 'creator.canvas',
			conversation: page.activeMode === CreatorMode.Design ? 'optional' : undefined, showEditorTabs: page.activeMode !== CreatorMode.Design, sidebarContainerId: DESIGN_LAYERS_CONTAINER_ID,
			detailsContainerId: DESIGN_PROPERTIES_CONTAINER_ID,
		} : { ...entry, sidebarContainerId: page.navigationContainerId };
	}, source ? { source } : undefined);
}

CommandsRegistry.register('sessions.show.creator', accessor => openCreator(accessor, 'home'));
CommandsRegistry.register('sessions.restore.creator', (accessor, source) => openCreator(accessor, undefined, source === 'restore' ? source : undefined));
CommandsRegistry.register('sessions.restore.creatorDesign', (accessor, source) => openCreator(accessor, CreatorMode.Design, source === 'restore' ? source : undefined));
CommandsRegistry.register('sessions.creator.openMode', (accessor, value) => {
	if (!Object.values(CreatorMode).includes(value as CreatorMode)) { throw new TypeError(localize('sessions.creator.invalidMode', 'Invalid Artifacts document mode.')); }
	return openCreator(accessor, value as CreatorMode);
});

function createDocumentOpener(accessor: ServicesAccessor): (resource: URI, source?: 'restore') => Promise<void> {
	const editors = accessor.get(IEditorPart);
	const storage = accessor.get(IStorageService);
	const layout = accessor.get(ISessionsLayoutService);
	const views = accessor.get(IViewsService);
	return (resource, source) => {
		const input = editors.groups.flatMap(group => group.editors.map(editor => editor.input)).find(input => input.resource.toString() === resource.toString())
			?? {
			resource,
			...(resource.scheme === 'untitled' ? { initialText: '' } : {}),
			...(resource.path.endsWith('.ash-doc') ? { contentType: GENERAL_DOCUMENT_CONTENT_TYPE } : { languageId: 'markdown', contentType: 'text/markdown' }),
		};
		storage.store('sessions.creator.activeDocument', resource.toString(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		return layout.openEntry({
			id: 'creator.docs', activityContext: 'sessions.activity.creatorSelected', content: 'editor',
			sidebarContainerId: views.getVisibleViewContainer(ViewContainerLocation.Sidebar)?.id,
			editorInput: input, restoreCommand: 'sessions.restore.creatorDocs', focus: 'editor',
		}, undefined, source ? { source } : undefined);
	};
}

function recommendRichDocuments(accessor: ServicesAccessor): void {
	accessor.get(IExtensionRecommendationsService).recommendForResource(URI.parse('untitled:/document.ash-doc'));
}

CommandsRegistry.register('sessions.creator.newDocument', accessor => {
	// Rich document providers are optional. The built-in Markdown editor also owns real drafts and saves.
	const richDocuments = EditorPanes.getEditorPane({ resource: URI.parse('untitled:/document.ash-doc'), contentType: GENERAL_DOCUMENT_CONTENT_TYPE })?.resolveDocumentProfile;
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
		const richAvailable = !!EditorPanes.getEditorPane({ resource: URI.parse('untitled:/document.ash-doc'), contentType: GENERAL_DOCUMENT_CONTENT_TYPE })?.resolveDocumentProfile;
		using store = new DisposableStore();
		const picker = store.add(accessor.get(IQuickInputService).createQuickPick<{ readonly id: DocsEditorPreference | 'extensions'; readonly label: string; readonly detail?: string; readonly picked?: boolean; }>());
		picker.placeholder = picker.ariaLabel = localize('sessions.artifacts.chooseEditor', 'Choose Docs editor');
		picker.items = [
			{ id: 'automatic', label: localize('sessions.artifacts.automatic', 'Automatic'), picked: current === 'automatic', detail: localize('sessions.artifacts.automaticDetail', 'Use a rich document extension when available, otherwise Markdown.') },
			{ id: 'rich', label: localize('sessions.artifacts.rich', 'Rich document'), picked: current === 'rich', detail: richAvailable ? undefined : localize('sessions.artifacts.richUnavailable', 'Requires a rich document extension. Markdown stays available while you install one.') },
			{ id: 'markdown', label: localize('sessions.artifacts.markdown', 'Markdown'), picked: current === 'markdown' },
			{ id: 'extensions', label: localize('sessions.artifacts.findRichEditor', 'Find rich document extensions') },
		];
		const selected = await new Promise<DocsEditorPreference | 'extensions' | undefined>(resolve => {
			store.add(picker.onDidAccept(() => { resolve(picker.selectedItems[0]?.id); picker.hide(); }));
			store.add(picker.onDidHide(() => resolve(undefined)));
			picker.show();
		});
		if (!selected) { return; }
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
		if (!rich && !EditorPanes.getEditorPane({ resource: URI.parse('untitled:/document.ash-doc'), contentType: GENERAL_DOCUMENT_CONTENT_TYPE })?.resolveDocumentProfile) {
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
	if (!saved) { return openCreator(accessor, 'home', source === 'restore' ? source : undefined); }
	const resource = URI.parse(saved);
	if (!['file', 'untitled'].includes(resource.scheme) || !/\.(?:ash-doc|md)$/u.test(resource.path)) { return openCreator(accessor, 'home', source === 'restore' ? source : undefined); }
	return createDocumentOpener(accessor)(resource, source === 'restore' ? source : undefined);
});

registerAction2(class OpenCreator extends Action2 {
	constructor() {
		super({ id: 'sessions.open.creator', title: localize2('sessions.creator.title', 'Artifacts'), icon: Lxicon.artifacts, toggled: ContextKeyExpr.has('sessions.activity.creatorSelected'), menu: { id: Menus.ActivityBar, group: 'navigation', order: 50 } });
	}
	public override async run(accessor: ServicesAccessor): Promise<void> { await accessor.get(ICommandService).executeCommand('sessions.show.creator'); }
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Creator,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError(localize('sessions.creator.verbosityInvalid', 'Artifacts accessibility verbosity must be boolean.')); }
		return value;
	},
	setting: { valueType: 'boolean', get title() { return localize('sessions.creator.verbosityTitle', 'Artifacts accessibility help'); }, get description() { return localize('sessions.creator.verbosityDescription', 'Announce how to open accessibility help in Artifacts.'); } },
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type,
		priority: 90,
		name: `sessionsCreator${type}`,
		when: ContextKeyExpr.has('sessionsCreatorFocused'),
		getProvider: accessor => {
			const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
			const page = CreatorPage.getFocused(focused);
			if (!page) { return undefined; }
			return new AccessibleContentProvider(AccessibleViewProviderId.Creator, { type }, () => type === AccessibleViewType.Help ? `${localize('sessions.creator.help', 'Artifacts\nUse Tab and Shift+Tab to reach filters, search, view options, Docs, Slides, Design and your existing work. Press Enter to open an item. Use Left and Right to move between All, Yours and Shared with you. Search filters titles; sort changes title order; list view changes the presentation. The Artifacts navigation item returns home and retains each workspace. The dropdown beside Docs chooses Automatic, Rich document or Markdown. Switch Docs editor in the editor title opens a converted copy and keeps the original. Missing rich document extensions can be recommended; dismiss the notification or hide future suggestions. Design saves automatically; Slides uses Save document. Preview supports Left and Right to change slides and Escape to return.')}\n\n${page.getAccessibleContent()}` : page.getAccessibleContent(), () => focused.focus(), AccessibilityVerbositySettingId.Creator);
		},
	});
}
