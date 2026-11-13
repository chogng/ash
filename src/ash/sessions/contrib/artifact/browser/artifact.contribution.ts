import { getActiveElement } from '../../../../base/browser/dom.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import type { ArtifactWorkspaceId } from '../common/artifactWorkspace.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Menus } from '../../../browser/menus.js';
import { ArtifactEditorView, ArtifactEditorPane } from './artifactEditor.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { getArtifactWorkspace } from './artifactWorkspaceRegistry.js';
import { isArtifactKind } from '../../../common/artifactKind.js';
import { getArtifactExample, OPEN_ARTIFACT_EXAMPLE } from './artifactExamples.js';
import { openArtifacts } from './artifactWorkspaceOpener.js';

registerEditorPane({ id: 'sessions.editor.creator', name: 'Artifacts', canOpen: input => input.resource.scheme === 'ash-creator' && input.resource.path === '/page' ? EditorPaneMatch.Default : EditorPaneMatch.None, create: options => options.instantiationService!.createInstance(ArtifactEditorPane) });

CommandsRegistry.register('sessions.show.creator', (accessor, source) => openArtifacts(accessor, page => page.showHome(), { source: source === 'restore' ? source : undefined }));
CommandsRegistry.register('sessions.restore.creator', (accessor, source) => openArtifacts(accessor, undefined, { source: source === 'restore' ? source : undefined, restoreCommand: 'sessions.restore.creator' }));
CommandsRegistry.register('sessions.creator.openMode', (accessor, value) => {
	if (typeof value !== 'string' || !getArtifactWorkspace(value)) { throw new TypeError(localize('sessions.creator.invalidMode', 'Invalid Artifacts document mode.')); }
	return openArtifacts(accessor, page => page.openMode(value as ArtifactWorkspaceId), { restoreCommand: 'sessions.restore.creator' });
});
CommandsRegistry.register(OPEN_ARTIFACT_EXAMPLE, (accessor, kind) => {
	if (!isArtifactKind(kind)) {
		throw new TypeError(localize('sessions.creator.invalidMode', 'Invalid Artifacts document mode.'));
	}
	return getArtifactExample(kind)?.open(accessor);
});

registerAction2(class OpenCreator extends Action2 {
	constructor() {
		super({ id: 'sessions.open.creator', title: localize2('sessions.creator.title', 'Artifacts'), icon: Lxicon.artifacts, toggled: ContextKeyExpr.has('sessions.activity.creatorSelected'), menu: { id: Menus.ActivityBar, group: 'navigation', order: 50, when: ContextKeyExpr.notEquals(SessionsWorkspaceModeContext.key, 'code') } });
	}
	public override async run(accessor: ServicesAccessor): Promise<void> { await accessor.get(ICommandService).executeCommand('sessions.show.creator'); }
});

registerAction2(class BackToArtifacts extends Action2 {
	constructor() {
		super({
			id: 'sessions.creator.canvas.home', title: localize2('sessions.creator.home', 'Artifacts home'), icon: Lxicon.arrowLeft,
			menu: { id: Menus.ArtifactTitleBar, group: 'navigation', order: -1 },
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
			const page = ArtifactEditorView.getFocused(focused);
			if (!page) { return undefined; }
			return new AccessibleContentProvider(AccessibleViewProviderId.Creator, { type }, () => type === AccessibleViewType.Help ? `${localize('sessions.creator.help', 'Artifacts\nUse Tab and Shift+Tab to reach filters, search, view options, creation cards and your existing work. Press Enter on a creation card to open a new chat with that artifact type shown below the input. Use the window title bar to return to Artifacts. Show Secondary Side Bar opens canvas properties when available. Press Enter on existing work to open it. Use Left and Right to move between All, Yours and Shared with you. Press Enter or Space to apply the focused filter. Search filters titles; sort changes title order. Layout grid switches your work between grid and list views. The Artifacts navigation item returns home and retains each workspace. In the Command Palette, Choose Docs editor sets the editor preference and can open a blank document. Docs uses rich document or Markdown format according to the Docs editor preference. Design saves automatically. Use Save document for files opened in the Slides workspace. Preview supports Left and Right to change slides and Escape to return.')}\n${localize('sessions.artifacts.examplesHelp', 'In All, press Enter on the Slides example to create a deck. The deck saves automatically and can be reopened from Yours. Use Export editable copy to create a file package. Other canvas examples keep edits for this window. Docs, Sheet and Data examples are read-only.')}\n\n${page.getWorkspaceAccessibilityHelp() ?? ''}${page.getAccessibleContent()}` : page.getAccessibleContent(), () => focused.focus(), AccessibilityVerbositySettingId.Creator);
		},
	});
}
