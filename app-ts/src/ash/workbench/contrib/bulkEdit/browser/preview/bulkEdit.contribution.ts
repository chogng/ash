import { Disposable, DisposableStore, toDisposable } from "../../../../../base/common/lifecycle.js";
import { addDisposableListener, isHTMLElement } from '../../../../../base/browser/dom.js';
import { isCancellationError } from "../../../../../base/common/errors.js";
import { IBulkEditService, type ResourceEdit } from '../../../../../editor/browser/services/bulkEditService.js';
import { IDialogService } from "../../../../../platform/dialogs/common/dialogs.js";
import { SyncDescriptor } from "../../../../../platform/instantiation/common/descriptors.js";
import { registerWorkbenchContribution, WorkbenchPhase } from "../../../../common/contributions.js";
import { ViewContainerLocation, type WorkbenchViewRegistry, WorkbenchViewContainerId, ViewsRegistry } from "../../../../common/views.js";
import { IViewsService } from "../../../../services/views/browser/viewsService.js";
import { BulkEditPane } from "./bulkEditPane.js";
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import type { IContextKey } from '../../../../../platform/contextkey/common/contextkey.js';

const previewActions = [
	{ id: 'refactorPreview.apply', title: localize('bulkEdit.applySelected', 'Apply selected'), run: (pane: BulkEditPane) => pane.accept() },
	{ id: 'refactorPreview.discard', title: localize('bulkEdit.cancel', 'Cancel'), run: (pane: BulkEditPane) => pane.discard() },
	{ id: 'refactorPreview.toggleCheckedState', title: localize('bulkEdit.toggleChecked', 'Toggle selected change'), run: (pane: BulkEditPane) => pane.toggleChecked() },
	{ id: 'refactorPreview.groupByFile', title: localize('bulkEdit.groupByFile', 'Group by file'), run: (pane: BulkEditPane) => pane.groupByFile() },
	{ id: 'refactorPreview.groupByType', title: localize('bulkEdit.groupByType', 'Group by type'), run: (pane: BulkEditPane) => pane.groupByType() },
	{ id: 'refactorPreview.toggleGrouping', title: localize('bulkEdit.toggleGrouping', 'Toggle grouping'), run: (pane: BulkEditPane) => pane.toggleGrouping() },
];

for (const action of previewActions) {
	registerAction2(class extends Action2 {
		constructor() {
			super({ id: action.id, title: action.title, f1: true, precondition: ContextKeyExpr.has('refactorPreview.enabled') });
		}
		public run(accessor: ServicesAccessor): void {
			const pane = accessor.get(IViewsService).getViewWithId(BulkEditPane.ID);
			if (pane instanceof BulkEditPane && pane.hasInput) {
				action.run(pane);
			}
		}
	});
}

/** Registers the Workbench panel that hosts the transient bulk-edit preview. */
export function registerBulkEditView(registry: WorkbenchViewRegistry = ViewsRegistry): void {
	registry.registerStaticViewContainer({ id: WorkbenchViewContainerId.BulkEdit, title: "Refactor Preview", localizationKey: { bundle: "ash.views", key: "refactorPreview" }, location: ViewContainerLocation.Panel, order: 2.75 });
	registry.registerStaticViews(WorkbenchViewContainerId.BulkEdit, [{
		id: BulkEditPane.ID,
		title: "Refactor Preview",
		localizationKey: { bundle: "ash.views", key: "refactorPreview" },
		order: 1,
		hideByDefault: true,
		canToggleVisibility: false,
		ctorDescriptor: new SyncDescriptor(BulkEditPane),
	}]);
}

/** Connects the bulk-edit service to the transient preview pane. */
export class BulkEditPreviewContribution extends Disposable {
	private activeSession: PreviewSession | undefined;
	private readonly enabledContext: IContextKey<boolean>;

	constructor(
		@IBulkEditService bulkEdits: IBulkEditService,
		@IViewsService private readonly views: IViewsService,
		@IDialogService private readonly dialogs: IDialogService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super();
		this.enabledContext = contextKeys.createKey('refactorPreview.enabled', false);
		this._register(bulkEdits.setPreviewHandler((edits, options) => this.preview(edits, options?.token ?? new AbortController().signal)));
		this._register(toDisposable(() => {
			this.activeSession?.controller.abort();
			this.enabledContext.reset();
		}));
	}

	private async preview(edits: ResourceEdit[], signal: AbortSignal): Promise<ResourceEdit[]> {
		const view = this.views.openView(BulkEditPane.ID);
		if (!(view instanceof BulkEditPane)) throw new Error("Bulk edit preview view is not available");
		if (this.activeSession) {
			const previous = this.activeSession;
			const confirmed = await this.dialogs.confirm({
				title: localize('bulkEdit.title', 'Refactor Preview'),
				message: localize('bulkEdit.anotherPreview', 'Another refactoring is being previewed.'),
				detail: localize('bulkEdit.replacePreview', 'Continue to discard the previous refactoring and preview this one?'),
				primaryButton: localize('bulkEdit.continue', 'Continue'),
				cancelButton: localize('bulkEdit.cancel', 'Cancel'),
			});
			if (!confirmed.confirmed || signal.aborted || this.activeSession !== previous) return [];
			previous.controller.abort();
			view.discard();
		}
		const controller = new AbortController();
		const lifetime = new DisposableStore();
		lifetime.add(addDisposableListener(signal, 'abort', () => controller.abort(), { once: true }));
		if (signal.aborted) controller.abort();
		const session = { controller };
		this.activeSession = session;
		this.enabledContext.set(true);
		try {
			if (controller.signal.aborted) return [];
			return await view.setInput(edits, controller.signal) ?? [];
		} catch (error) {
			if (isCancellationError(error) || controller.signal.aborted) return [];
			throw error;
		} finally {
			lifetime.dispose();
			if (this.activeSession === session) {
				this.activeSession = undefined;
				this.enabledContext.set(false);
			}
		}
	}
}

registerBulkEditView();

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type, priority: 110, name: `bulk-edit-preview-${type}`,
		getProvider: accessor => {
			const pane = accessor.get(IViewsService).getViewWithId(BulkEditPane.ID);
			if (!(pane instanceof BulkEditPane) || !pane.isVisible()) return undefined;
			const focused = pane.element.ownerDocument.activeElement;
			if (!focused || !pane.element.contains(focused)) return undefined;
			return new AccessibleContentProvider(AccessibleViewProviderId.BulkEditPreview, { type },
				() => type === AccessibleViewType.View ? pane.getAccessibleContent() : localize('bulkEdit.help', 'Refactor preview\nUse Tab and Shift+Tab to move between changes and actions. Press Space to select a change. File operations and dependent text changes are selected together. Choose Open changes to review the selected replacements in a diff editor, or expand Show text change. Group by file or type to organize the changes. Press Ctrl or Command+Enter to apply selected changes. Press Escape to cancel. Changes to the source files disable Apply; cancel and run the refactoring again. Press Alt+F2 to read the full changes.'),
				() => { if (isHTMLElement(focused) && focused.isConnected) focused.focus(); },
				AccessibilityVerbositySettingId.BulkEditPreview);
		},
	});
}
interface PreviewSession {
	readonly controller: AbortController;
}

registerWorkbenchContribution("workbench.contrib.bulkEditPreview", WorkbenchPhase.BlockRestore, accessor => accessor.get(IInstantiationService).createInstance(BulkEditPreviewContribution));
