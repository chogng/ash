import { EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { FocusedViewContext } from '../../../common/contextkeys.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { localize } from '../../../../nls.js';
import { TestingEditorContribution } from './testingEditorContribution.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewContainerLocation, type WorkbenchViewRegistry, WorkbenchViewContainerId, ViewsRegistry } from '../../../common/views.js';
import { TESTING_VIEW_ID } from '../common/testing.js';
import { TestingViewPane } from './testingViewPane.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase, type IWorkbenchContribution } from '../../../common/contributions.js';
import { ITaskService } from '../../tasks/common/taskService.js';
import { ITestingService } from '../../../services/testing/common/testingService.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import './testingActions.js';
import '../../../services/testing/browser/testingServiceRegistration.js';
import './media/testing.css';

const hasTestCapability = new RawContextKey<boolean>('testing.hasTestCapability', false);

export function registerTestingView(registry: WorkbenchViewRegistry = ViewsRegistry): void {
	registry.registerStaticViewContainer({
		id: WorkbenchViewContainerId.Testing,
		title: 'Testing',
		localizationKey: { bundle: 'ash.views', key: 'testing' },
		location: ViewContainerLocation.Sidebar,
		icon: Lxicon.beaker,
		order: 4,
		hideIfEmpty: true,
	});
	registry.registerStaticViews(WorkbenchViewContainerId.Testing, [{
		id: TESTING_VIEW_ID,
		title: 'Testing',
		localizationKey: { bundle: 'ash.views', key: 'testing' },
		order: 1,
		canToggleVisibility: false,
		when: hasTestCapability.isEqualTo(true),
		ctorDescriptor: new SyncDescriptor(TestingViewPane),
	}]);
}

registerTestingView();

/** Projects the testing owner's availability into navigation without discovering or running tests. */
class TestingContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@ITestingService testing: ITestingService,
		@IContextKeyService contextKeys: IContextKeyService,
		@ITaskService private readonly tasks: ITaskService,
	) {
		super();
		const capability = hasTestCapability.bindTo(contextKeys);
		this._register(toDisposable(() => capability.reset()));
		capability.set(testing.hasTestCapability);
		this._register(testing.onDidChangeTestCapability(() => capability.set(testing.hasTestCapability)));
	}

	public async onWorkspaceRestored(): Promise<void> {
		// Reuse task detection and its file watchers; Rust discovery can build test targets.
		await this.tasks.refresh();
	}
}

registerWorkbenchContribution('workbench.contrib.testing', WorkbenchPhase.AfterRestored, accessor => {
	const contribution = accessor.get(IInstantiationService).createInstance(TestingContribution);
	void contribution.onWorkspaceRestored().catch(onUnexpectedError);
	return contribution;
});

registerEditorContribution({
	id: 'workbench.contrib.testing.editor',
	instantiation: EditorContributionInstantiation.Eager,
	install: context => context.kind === 'text' ? context.instantiationService.createInstance(TestingEditorContribution, context.editor, context.model) : undefined,
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type, priority: 100, name: 'testing.' + type,
		when: FocusedViewContext.isEqualTo(TESTING_VIEW_ID),
		getProvider: accessor => {
			const view = accessor.get(IViewsService).getViewWithId(TESTING_VIEW_ID);
			if (!(view instanceof TestingViewPane)) { return undefined; }
			const focused = view.element.ownerDocument.activeElement;
			return new AccessibleContentProvider(AccessibleViewProviderId.Testing, { type },
				() => type === AccessibleViewType.Help ? localize('testing.accessibilityHelp', 'Testing\nUse arrow keys to navigate packages, files, and tests. Press Enter to open a test. Use Tab to reach Run Selected, Debug Selected Test, Run All Tests, Rerun Failed, Refresh Tests, or Cancel Tests. Select a test to read its output and open its failure location. Test Scripts run project commands in the terminal. Use Run Test on Current Line or Debug Test on Current Line in the editor. Press F9 in the editor to toggle a breakpoint. Alt+Click a test gutter icon to debug. Tests are saved before execution. Refresh builds test targets to discover macro and asynchronous tests. Documentation tests run through rustdoc; they cannot be debugged here.') : view.getAccessibleContent(),
				() => { if (focused instanceof HTMLElement) { focused.focus(); } }, AccessibilityVerbositySettingId.Testing);
		},
	});
}
