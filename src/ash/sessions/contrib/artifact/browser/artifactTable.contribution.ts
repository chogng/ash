import { getActiveElement } from '../../../../base/browser/dom.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { isResourceDiffEditorInput } from '../../../../workbench/common/editor.js';
import { getArtifactTitle } from './artifactKindPresentation.js';
import { ArtifactTableEditor } from './artifactTableEditor.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ArtifactTableService } from './artifactTableService.js';
import { IArtifactTableService } from '../common/artifactTableService.js';

registerSingleton(IArtifactTableService, ArtifactTableService, InstantiationType.Delayed);

registerEditorPane({
	id: ArtifactTableEditor.ID,
	get name() { return getArtifactTitle('sheet'); },
	canOpen: input => input.editorId === ArtifactTableEditor.ID && !isResourceDiffEditorInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create(options) { return options.instantiationService!.createInstance(ArtifactTableEditor); },
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type, priority: 95, name: `sessionsTable${type}`,
		getProvider: accessor => {
			const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement | null;
			const pane = focused && ArtifactTableEditor.getFocused(focused);
			if (!pane) return undefined;
			return new AccessibleContentProvider(AccessibleViewProviderId.Creator, { type },
				() => type === AccessibleViewType.Help ? pane.getAccessibilityHelp() : pane.getAccessibleContent(),
				() => focused.focus(), AccessibilityVerbositySettingId.Creator);
		},
	});
}
