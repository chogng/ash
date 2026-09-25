import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { registerEditorPane } from '../../../browser/parts/editor/editorRegistry.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { GettingStartedFocusedContext, GettingStartedPage, GettingStartedPageId } from './gettingStarted.js';
import { createGettingStartedInput, isGettingStartedInput } from './gettingStartedInput.js';
import { StartupPageRunnerContribution } from './startupPage.js';

registerEditorPane({
	id: GettingStartedPageId,
	name: localize('gettingStarted.title', 'Welcome'),
	canOpen: input => isGettingStartedInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => {
		if (!options.instantiationService) throw new Error('Welcome editor requires the Instantiation Service');
		return options.instantiationService.createInstance(GettingStartedPage);
	},
});

registerWorkbenchContribution('workbench.contrib.startupPageRunner', WorkbenchPhase.AfterRestored, accessor =>
	accessor.get(IInstantiationService).createInstance(StartupPageRunnerContribution));

registerAction2(class OpenWelcomeAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.openWelcome', title: localize('gettingStarted.openWelcome', 'Welcome'), f1: true });
	}

	public override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IEditorService).openEditor(createGettingStartedInput());
	}
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	priority: 100,
	name: 'gettingStartedHelp',
	when: GettingStartedFocusedContext.isEqualTo(true),
	getProvider: accessor => new AccessibleContentProvider(
		AccessibleViewProviderId.GettingStarted,
		{ type: AccessibleViewType.Help },
		() => localize('gettingStarted.accessibilityHelp', 'Welcome\nUse Tab and Shift+Tab to move between actions and recent projects. Press Enter to activate the focused item.'),
		() => accessor.get(IEditorService).focusActiveEditor(),
		AccessibilityVerbositySettingId.GettingStarted,
	),
});
