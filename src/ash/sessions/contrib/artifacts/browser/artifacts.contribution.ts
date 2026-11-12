import { getActiveElement } from '../../../../base/browser/dom.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { URI } from '../../../../base/common/uri.js';
import { isUuid } from '../../../../base/common/uuid.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { AuxiliaryBarVisibleContext } from '../../../../workbench/common/contextkeys.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { ISessionsEntryService, type ISessionsEntry } from '../../../services/layout/common/sessionsEntryService.js';
import { artifactDetailEntry, ArtifactWorkspaceId } from '../common/artifactWorkspace.js';
import { DESIGN_PROPERTIES_CONTAINER_ID, IDesignEditorService } from './designEditorService.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Menus } from '../../../browser/menus.js';
import { ArtifactsEditorView, ArtifactsEditorPane, NEW_ARTIFACT, OPEN_CANVAS_ARTIFACT } from './artifactsEditor.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { SessionsEntryDetailsContext, SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import { isArtifactKind } from '../../../common/artifactKind.js';
import { CanvasWorkspace } from './canvasWorkspace.js';
import { getArtifactExample, OPEN_ARTIFACT_EXAMPLE } from './artifactExamples.js';
import { openDocsExample } from '../contrib/docs/browser/documentActions.js';

CanvasWorkspace.registerFileActions();
registerEditorPane({ id: 'sessions.editor.creator', name: 'Artifacts', canOpen: input => input.resource.scheme === 'ash-creator' && input.resource.path === '/page' ? EditorPaneMatch.Default : EditorPaneMatch.None, create: options => options.instantiationService!.createInstance(ArtifactsEditorPane) });

async function openArtifacts(accessor: ServicesAccessor, select?: (page: ArtifactsEditorView) => void, options: { source?: 'restore'; restoreCommand?: string; reveal?: boolean; } = {}): Promise<void> {
	const editor = accessor.get(IEditorPart);
	const entry: ISessionsEntry = {
		id: 'creator.home', workspaceMode: 'current', activityContext: 'sessions.activity.creatorSelected', content: 'editor',
		showEditorTabs: false,
		restoreCommand: options.restoreCommand ?? 'sessions.show.creator',
		focus: 'editor',
		editorInput: {
			resource: URI.from({ scheme: 'ash-creator', path: '/page' }), label: localize('sessions.creator.title', 'Artifacts'),
			showBreadcrumbs: false, readOnly: true, capabilities: EditorInputCapabilities.CannotClose,
		},
	};
	let page: ArtifactsEditorView | undefined;
	await accessor.get(ISessionsEntryService).openEntry(entry, () => {
		page = (editor.activePane as ArtifactsEditorPane).page;
		select?.(page);
		if (page.isHome) return entry;
		return {
			...entry,
			...artifactDetailEntry,
			id: `creator.workspace.${page.activeKind ?? page.activeMode}`,
			detailsContainerId: page.usesCanvasPanels ? DESIGN_PROPERTIES_CONTAINER_ID : undefined,
			conversationKind: page.activeMode === ArtifactWorkspaceId.Make ? 'code' : undefined,
		};
	}, { source: options.source, preserveChatSource: true });
	if (options.reveal) {
		// Wait for the entry's editor geometry before framing the content.
		page?.revealInitialContent();
	}
}

CommandsRegistry.register('sessions.show.creator', (accessor, source) => openArtifacts(accessor, page => page.showHome(), { source: source === 'restore' ? source : undefined }));
CommandsRegistry.register('sessions.restore.creator', (accessor, source) => openArtifacts(accessor, undefined, { source: source === 'restore' ? source : undefined, restoreCommand: 'sessions.restore.creator' }));
CommandsRegistry.register('sessions.restore.creatorDesign', (accessor, source) => openArtifacts(accessor, page => page.openMode(ArtifactWorkspaceId.Design), { source: source === 'restore' ? source : undefined, restoreCommand: 'sessions.restore.creator' }));
CommandsRegistry.register(NEW_ARTIFACT, (accessor, kind) => {
	if (!isArtifactKind(kind)) {
		throw new TypeError(localize('sessions.creator.invalidMode', 'Invalid Artifacts document mode.'));
	}
	if (kind === 'docs') return accessor.get(ICommandService).executeCommand('sessions.creator.newDocument');
	if (kind === 'sheet' || kind === 'data') return openArtifacts(accessor, page => page.createTable(kind));
	const document = accessor.get(IDesignEditorService).createCanvasArtifact(kind, []);
	return openArtifacts(accessor, page => page.openCanvasArtifact(document));
});
CommandsRegistry.register('sessions.creator.openMode', (accessor, value) => {
	if (!Object.values(ArtifactWorkspaceId).includes(value as ArtifactWorkspaceId)) { throw new TypeError(localize('sessions.creator.invalidMode', 'Invalid Artifacts document mode.')); }
	return openArtifacts(accessor, page => page.openMode(value as ArtifactWorkspaceId), { restoreCommand: 'sessions.restore.creator' });
});
CommandsRegistry.register(OPEN_CANVAS_ARTIFACT, (accessor, id) => {
	const document = isUuid(id) ? accessor.get(IDesignEditorService).canvasArtifacts.get().get(id) : undefined;
	if (document) { return openArtifacts(accessor, page => page.openCanvasArtifact(document), { reveal: true }); }
});
CommandsRegistry.register('sessions.creator.openTable', (accessor, key) => {
	if (typeof key === 'string' && key.startsWith('table:') && isUuid(key.slice('table:'.length))) {
		return openArtifacts(accessor, page => page.openTable(key));
	}
});
CommandsRegistry.register(OPEN_ARTIFACT_EXAMPLE, (accessor, kind) => {
	if (!isArtifactKind(kind)) {
		throw new TypeError(localize('sessions.creator.invalidMode', 'Invalid Artifacts document mode.'));
	}
	const example = getArtifactExample(kind);
	return example.type === 'docs' ? openDocsExample(accessor, example) : openArtifacts(accessor, page => page.openExample(example), { reveal: true });
});

registerAction2(class OpenCreator extends Action2 {
	constructor() {
		super({ id: 'sessions.open.creator', title: localize2('sessions.creator.title', 'Artifacts'), icon: Lxicon.artifacts, toggled: ContextKeyExpr.has('sessions.activity.creatorSelected'), menu: { id: Menus.ActivityBar, group: 'navigation', order: 50, when: ContextKeyExpr.notEquals(SessionsWorkspaceModeContext.key, 'code') } });
	}
	public override async run(accessor: ServicesAccessor): Promise<void> { await accessor.get(ICommandService).executeCommand('sessions.show.creator'); }
});

registerAction2(class ToggleArtifactDetails extends Action2 {
	constructor() {
		const when = SessionsEntryDetailsContext.isEqualTo(DESIGN_PROPERTIES_CONTAINER_ID);
		const show = localize2({ bundle: 'ash.actions', key: 'showSecondarySidebar' }, 'Show Secondary Side Bar');
		const hide = localize2({ bundle: 'ash.actions', key: 'hideSecondarySidebar' }, 'Hide Secondary Side Bar');
		super({
			id: 'sessions.creator.toggleDetails', title: show, tooltip: show, icon: Lxicon.layoutSidebarRightOff,
			toggled: { condition: AuxiliaryBarVisibleContext.isEqualTo(true), title: hide, tooltip: hide, icon: Lxicon.layoutSidebarRight },
			precondition: when, f1: true,
			menu: { id: Menus.ArtifactCanvasToolbar, when, group: 'navigation', order: -1 },
		});
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const layout = accessor.get(IAgentWorkbenchLayoutService);
		if (layout.isPartVisible('auxiliarybar')) {
			const hadFocus = layout.mainContainer.querySelector('[data-part="auxiliarybar"]')?.contains(getActiveElement(layout.mainContainer.ownerDocument));
			layout.hidePart('auxiliarybar');
			if (hadFocus) accessor.get(IEditorService).focusActiveEditor();
		} else {
			await accessor.get(IViewsService).openViewContainer(DESIGN_PROPERTIES_CONTAINER_ID, false);
		}
	}
});

registerAction2(class BackToArtifacts extends Action2 {
	constructor() {
		super({
			id: 'sessions.creator.canvas.home', title: localize2('sessions.creator.home', 'Artifacts home'), icon: Lxicon.arrowLeft,
			menu: { id: Menus.ArtifactCanvasToolbar, group: 'navigation', order: -2 },
		});
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand('sessions.show.creator');
	}
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
			const page = ArtifactsEditorView.getFocused(focused);
			if (!page) { return undefined; }
			return new AccessibleContentProvider(AccessibleViewProviderId.Creator, { type }, () => type === AccessibleViewType.Help ? `${localize('sessions.creator.help', 'Artifacts\nUse Tab and Shift+Tab to reach filters, search, view options, creation cards and your existing work. Press Enter on a creation card to open its editor. The toolbar is above the content. Show Secondary Side Bar opens canvas properties when available. Press Enter on existing work to open it. Use Left and Right to move between All, Yours and Shared with you. Press Enter or Space to apply the focused filter. Search filters titles; sort changes title order. Layout grid switches your work between grid and list views. The Artifacts navigation item returns home and retains each workspace. In the Command Palette, Choose Docs editor sets the editor preference and can open a blank document. Docs uses rich document or Markdown format according to the Docs editor preference. Design saves automatically. Use Save document for files opened in the Slides workspace. Preview supports Left and Right to change slides and Escape to return.')}\n${localize('sessions.artifacts.examplesHelp', 'In All, press Enter on the Slides example to create a deck. The deck saves automatically and can be reopened from Yours. Use Export editable copy to create a file package. Other canvas examples keep edits for this window. Docs, Sheet and Data examples are read-only.')}\n\n${page.getAccessibleContent()}` : page.getAccessibleContent(), () => focused.focus(), AccessibilityVerbositySettingId.Creator);
		},
	});
}
