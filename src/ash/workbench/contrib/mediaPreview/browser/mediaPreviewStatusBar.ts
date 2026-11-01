import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { SideBySideEditor } from '../../../browser/parts/editor/sideBySideEditor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IStatusbarService, StatusbarAlignment, type IStatusbarEntryAccessor } from '../../../services/statusbar/browser/statusbar.js';
import { getActiveImagePreview } from './activeMediaPreview.js';
import { ImagePreviewEditor } from './imagePreviewEditor.js';
import { selectImageZoomLevel } from './mediaPreviewActions.js';

export class MediaPreviewStatusBarContribution extends Disposable {
	private readonly listeners = this._register(new DisposableStore());
	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IEditorService private readonly editors: IEditorService,
		@IStatusbarService private readonly statusbar: IStatusbarService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
	) {
		super();
		this._register(editors.onDidActiveEditorChange(() => this.followEditor()));
		this.followEditor();
	}

	private followEditor(): void {
		this.listeners.clear();
		const pane = this.editors.activeEditorPane;
		const panes = pane instanceof SideBySideEditor ? [pane.getSecondaryEditorPane(), pane.getPrimaryEditorPane()] : [pane];
		for (const candidate of panes) {
			if (!(candidate instanceof ImagePreviewEditor)) continue;
			this.listeners.add(candidate.onDidChangeImageInfo(() => this.update()));
			this.listeners.add(candidate.onDidFocus(() => this.update()));
		}
		this.update();
	}

	private update(): void {
		const preview = getActiveImagePreview(this.editors.activeEditorPane);
		const size = preview?.imageViewer.naturalSize;
		if (!preview || !size || !preview.isVisible()) { this.entry.clear(); return; }
		const scale = preview.imageViewer.scale;
		const zoom = scale === 'fit' ? localize('media.image.fit', 'Fit to window') : `${Math.round(scale * 100)}%`;
		const text = localize('media.image.summary', '{0} × {1} pixels · {2} bytes · {3}', size.width, size.height, preview.fileSize ?? 0, zoom);
		const entry = {
			text, ariaLabel: text,
			tooltip: localize('media.image.selectZoom', 'Select image zoom level'),
			run: () => selectImageZoomLevel(preview.imageViewer, this.quickInput),
		};
		if (this.entry.value) this.entry.value.update(entry);
		else this.entry.value = this.statusbar.addEntry(entry, { id: 'status.mediaPreview', alignment: StatusbarAlignment.Right, priority: 100 });
	}
}
