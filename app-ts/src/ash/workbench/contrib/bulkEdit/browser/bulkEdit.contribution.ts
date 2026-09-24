import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { isCancellationError } from "../../../../base/common/errors.js";
import { type LanguageWorkspaceEdit } from "../../../../editor/common/languages.js";
import { IBulkEditService, ResourceEdit } from '../../../../editor/browser/services/bulkEditService.js';
import { ITextModelResourceService } from "../../../services/textmodelResolver/common/textModelResourceService.js";
import { IDialogService } from "../../../../platform/dialogs/common/dialogs.js";
import { ServiceConstructionDescriptor } from "../../../../platform/instantiation/common/instantiation.js";
import { IFileService } from "../../../../platform/files/common/files.js";
import { registerWorkbenchContribution, WorkbenchPhase } from "../../../common/contributions.js";
import { ViewContainerLocation, type WorkbenchViewRegistry, WorkbenchViewContainerId, ViewsRegistry } from "../../../common/views.js";
import { IViewsService } from "../../../services/views/browser/viewsService.js";
import { IWorkingCopyService } from "../../../services/workingCopy/common/workingCopyService.js";
import { createBulkEditPreview } from "./preview/bulkEditPreview.js";
import { BulkEditPreviewPane, BULK_EDIT_VIEW_ID } from "./preview/bulkEditPreviewPane.js";
import { toLanguageWorkspaceEdit } from './bulkEditService.js';
import "./media/bulkEdit.css";

/** Registers the Workbench panel that hosts the transient bulk-edit preview. */
export function registerBulkEditView(registry: WorkbenchViewRegistry = ViewsRegistry): void {
	registry.registerStaticViewContainer({ id: WorkbenchViewContainerId.BulkEdit, title: "Refactor Preview", localizationKey: { bundle: "ash.views", key: "refactorPreview" }, location: ViewContainerLocation.Panel, order: 2.75 });
	registry.registerStaticViews(WorkbenchViewContainerId.BulkEdit, [{
		id: BULK_EDIT_VIEW_ID,
		title: "Refactor Preview",
		localizationKey: { bundle: "ash.views", key: "refactorPreview" },
		order: 1,
		hideByDefault: true,
		canToggleVisibility: false,
		ctorDescriptor: new ServiceConstructionDescriptor(BulkEditPreviewPane),
	}]);
}

/** Connects the bulk-edit service to the transient preview pane. */
export class BulkEditPreviewContribution extends Disposable {
	private activeSession: PreviewSession | undefined;

	constructor(private readonly bulkEdits: IBulkEditService, private readonly views: IViewsService, private readonly files: IFileService, private readonly models: ITextModelResourceService, private readonly workingCopies: IWorkingCopyService, private readonly dialogs: IDialogService) {
		super();
		this._register(bulkEdits.setPreviewHandler((edits, options) => this.preview(edits, options?.token ?? new AbortController().signal)));
		this._register(toDisposable(() => this.activeSession?.controller.abort()));
	}

	private async preview(edits: ResourceEdit[], signal: AbortSignal): Promise<ResourceEdit[]> {
		const edit: LanguageWorkspaceEdit = toLanguageWorkspaceEdit(edits);
		const view = this.views.openView(BULK_EDIT_VIEW_ID);
		if (!(view instanceof BulkEditPreviewPane)) throw new Error("Bulk edit preview view is not available");
		if (this.activeSession) {
			const confirmed = await this.dialogs.confirm({
				title: "Refactor Preview",
				message: "Another refactoring is being previewed.",
				detail: "Continue to discard the previous refactoring and preview this one?",
				primaryButton: "Continue",
				cancelButton: "Cancel",
			});
			if (!confirmed) return [];
			this.activeSession.controller.abort();
			view.cancelInput();
		}
		const controller = new AbortController();
		const abort = (): void => controller.abort();
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) controller.abort();
		const session = { controller };
		this.activeSession = session;
		try {
			const model = await createBulkEditPreview(edit, { files: this.files, models: this.models, workingCopies: this.workingCopies }, controller.signal);
			const accepted = await view.setInput(model, controller.signal);
			return accepted ? ResourceEdit.convert(accepted) : [];
		} catch (error) {
			if (isCancellationError(error) || controller.signal.aborted) return [];
			throw error;
		} finally {
			signal.removeEventListener("abort", abort);
			if (this.activeSession === session) this.activeSession = undefined;
		}
	}
}

registerBulkEditView();
interface PreviewSession {
	readonly controller: AbortController;
}

registerWorkbenchContribution("workbench.contrib.bulkEditPreview", WorkbenchPhase.BlockRestore, accessor => new BulkEditPreviewContribution(accessor.get(IBulkEditService), accessor.get(IViewsService), accessor.get(IFileService), accessor.get(ITextModelResourceService), accessor.get(IWorkingCopyService), accessor.get(IDialogService)));
