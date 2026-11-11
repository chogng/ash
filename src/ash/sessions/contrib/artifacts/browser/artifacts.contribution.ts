import { getActiveElement } from '../../../../base/browser/dom.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { ISessionsLayoutService, type ISessionsEntry } from '../../../services/layout/common/sessionsLayoutService.js';
import { ArtifactWorkspaceId } from '../common/artifactWorkspace.js';
import { DESIGN_PROPERTIES_CONTAINER_ID } from './designEditorService.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Menus } from '../../../browser/menus.js';
import { ArtifactsEditorView, ArtifactsEditorPane } from './artifactsEditor.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { ArtifactDraftLabel, OPEN_ARTIFACT_DRAFT } from './artifactDraft.js';
import { isArtifactKind } from '../../../common/artifactKind.js';

registerEditorPane({ id: 'sessions.editor.creator', name: 'Artifacts', canOpen: input => input.resource.scheme === 'ash-creator' && input.resource.path === '/page' ? EditorPaneMatch.Default : EditorPaneMatch.None, create: options => options.instantiationService!.createInstance(ArtifactsEditorPane) });

function openArtifacts(accessor: ServicesAccessor, workspace?: ArtifactWorkspaceId | 'home', source?: 'restore'): Promise<void> {
	const editor = accessor.get(IEditorPart);
	const entry: ISessionsEntry = {
		id: 'creator.home', workspaceMode: 'current', activityContext: 'sessions.activity.creatorSelected', content: 'editor',
		showEditorTabs: false, restoreCommand: 'sessions.restore.creator', focus: 'editor',
		editorInput: {
			resource: URI.from({ scheme: 'ash-creator', path: '/page' }), label: localize('sessions.creator.title', 'Artifacts'),
			showBreadcrumbs: false, readOnly: true, capabilities: EditorInputCapabilities.CannotClose,
		},
	};
	return accessor.get(ISessionsLayoutService).openEntry(entry, () => {
		const page = (editor.activePane as ArtifactsEditorPane).page;
		if (workspace === 'home') { page.showHome(); }
		else if (workspace) { page.openMode(workspace); }
		return page.usesCanvasPanels ? {
			...entry, id: page.activeMode === ArtifactWorkspaceId.Design ? 'creator.design' : 'creator.canvas',
			conversation: page.activeMode === ArtifactWorkspaceId.Design ? 'optional' : undefined, showEditorTabs: page.activeMode !== ArtifactWorkspaceId.Design,
			detailsContainerId: DESIGN_PROPERTIES_CONTAINER_ID,
		} : entry;
	}, source ? { source } : undefined);
}

CommandsRegistry.register('sessions.show.creator', (accessor, source) => openArtifacts(accessor, 'home', source === 'restore' ? source : undefined));
CommandsRegistry.register('sessions.restore.creator', (accessor, source) => openArtifacts(accessor, undefined, source === 'restore' ? source : undefined));
CommandsRegistry.register('sessions.restore.creatorDesign', (accessor, source) => openArtifacts(accessor, ArtifactWorkspaceId.Design, source === 'restore' ? source : undefined));
CommandsRegistry.register(OPEN_ARTIFACT_DRAFT, async (accessor, kind) => {
	if (!isArtifactKind(kind)) {
		throw new TypeError(localize('sessions.creator.invalidMode', 'Invalid Artifacts document mode.'));
	}
	const widgets = accessor.get(IChatWidgetService);
	await accessor.get(ICommandService).executeCommand('sessions.newSession');
	const input = widgets.lastFocusedWidget?.input;
	if (input) ArtifactDraftLabel.show(input, kind);
});
CommandsRegistry.register('sessions.creator.openMode', (accessor, value) => {
	if (!Object.values(ArtifactWorkspaceId).includes(value as ArtifactWorkspaceId)) { throw new TypeError(localize('sessions.creator.invalidMode', 'Invalid Artifacts document mode.')); }
	return openArtifacts(accessor, value as ArtifactWorkspaceId);
});

registerAction2(class OpenCreator extends Action2 {
	constructor() {
		super({ id: 'sessions.open.creator', title: localize2('sessions.creator.title', 'Artifacts'), icon: Lxicon.artifacts, toggled: ContextKeyExpr.has('sessions.activity.creatorSelected'), menu: { id: Menus.ActivityBar, group: 'navigation', order: 50, when: ContextKeyExpr.notEquals(SessionsWorkspaceModeContext.key, 'code') } });
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
			const page = ArtifactsEditorView.getFocused(focused);
			if (!page) { return undefined; }
			return new AccessibleContentProvider(AccessibleViewProviderId.Creator, { type }, () => type === AccessibleViewType.Help ? `${localize('sessions.creator.help', 'Artifacts\nUse Tab and Shift+Tab to reach filters, search, view options, creation cards and your existing work. Press Enter on a creation card to open a new chat with that artifact type shown below the input. Press Enter on existing work to open it. Use Left and Right to move between All, Yours and Shared with you. Press Enter or Space to apply the focused filter. Search filters titles; sort changes title order. Layout grid switches your work between grid and list views. The Artifacts navigation item returns home and retains each workspace. In the Command Palette, Choose Docs editor sets the editor preference and can open a blank document. Switch Docs editor in the editor title opens a converted copy and keeps the original. Missing rich document extensions can be recommended; dismiss the notification or hide future suggestions. Design saves automatically; Slides uses Save document. Preview supports Left and Right to change slides and Escape to return.')}\n\n${page.getAccessibleContent()}` : page.getAccessibleContent(), () => focused.focus(), AccessibilityVerbositySettingId.Creator);
		},
	});
}
