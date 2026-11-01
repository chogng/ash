import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { SideBySideEditor } from '../../../browser/parts/editor/sideBySideEditor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IStatusbarService, StatusbarAlignment, type IStatusbarEntryAccessor } from '../../../services/statusbar/browser/statusbar.js';
import { getActiveImagePreview } from './activeMediaPreview.js';
import { ImagePreviewEditor } from './imagePreviewEditor.js';
import { selectImageZoomLevel } from './mediaPreviewActions.js';
import { ImagePreviewConfiguration } from '../common/mediaPreview.js';
import { ImagePreviewInfo } from './imagePreviewInfo.js';

export class MediaPreviewStatusBarContribution extends Disposable {
	private readonly listeners = this._register(new DisposableStore());
	private readonly infoEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly zoomEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly details = this._register(new MutableDisposable<ImagePreviewInfo>());

	constructor(
		@IEditorService private readonly editors: IEditorService,
		@IStatusbarService private readonly statusbar: IStatusbarService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		this._register(editors.onDidActiveEditorChange(() => this.followEditor()));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ImagePreviewConfiguration.showImageInfo)) { this.update(); }
		}));
		this.followEditor();
	}

	private followEditor(): void {
		this.details.clear();
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
		if (this.isDisposed) { return; }
		const preview = getActiveImagePreview(this.editors.activeEditorPane);
		if (this.details.value && this.details.value.preview !== preview) { this.details.clear(); }
		const size = preview?.imageViewer.naturalSize;
		if (!preview || !size || !preview.isVisible()) {
			this.details.clear();
			this.infoEntry.clear();
			this.zoomEntry.clear();
			return;
		}
		if (this.configuration.getValue<boolean>(ImagePreviewConfiguration.showImageInfo)) {
			const text = localize('media.image.info', '{0} × {1} pixels · {2} bytes', size.width, size.height, preview.fileSize ?? 0);
			const entry = {
				text, ariaLabel: text,
				tooltip: localize('media.image.viewInfo', 'View image information'),
				ariaHasPopup: 'dialog' as const,
				ariaExpanded: this.details.value?.visible ?? false,
				run: (anchor?: HTMLElement) => {
					if (!anchor) { return; }
					if (this.details.value?.visible) {
						this.details.clear();
					} else {
						this.details.value = this.instantiation.createInstance(ImagePreviewInfo, preview, anchor, () => this.update());
						this.details.value.show();
					}
					this.update();
				},
			};
			if (this.infoEntry.value) {
				this.infoEntry.value.update(entry);
			} else {
				this.infoEntry.value = this.statusbar.addEntry(entry, { id: 'status.mediaPreview', alignment: StatusbarAlignment.Right, priority: 100 });
			}
		} else {
			this.details.clear();
			this.infoEntry.clear();
		}
		const scale = preview.imageViewer.scale;
		const zoom = scale === 'fit' ? localize('media.image.fit', 'Fit to window') : `${Math.round(scale * 100)}%`;
		const entry = {
			text: zoom,
			ariaLabel: localize('media.image.zoomStatus', 'Image zoom: {0}', zoom),
			tooltip: localize('media.image.selectZoom', 'Select image zoom level'),
			run: () => selectImageZoomLevel(preview.imageViewer, this.quickInput),
		};
		if (this.zoomEntry.value) {
			this.zoomEntry.value.update(entry);
		} else {
			this.zoomEntry.value = this.statusbar.addEntry(entry, { id: 'status.mediaPreview.zoom', alignment: StatusbarAlignment.Right, priority: 101 });
		}
	}
}
