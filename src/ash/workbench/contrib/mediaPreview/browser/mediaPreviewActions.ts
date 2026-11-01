import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { getActiveImagePreview } from './activeMediaPreview.js';
import type { ImageViewer, ImageViewerScale } from './imageViewer.js';

export function selectImageZoomLevel(viewer: ImageViewer, quickInput: IQuickInputService): void {
	const lifetime = new DisposableStore();
	const picker = lifetime.add(quickInput.createQuickPick<IQuickPickItem & { scale: ImageViewerScale; }>());
	picker.placeholder = localize('media.image.selectZoom', 'Select image zoom level');
	const scales: ImageViewerScale[] = ['fit', 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10, 20];
	picker.items = scales.map(scale => ({ scale, label: scale === 'fit' ? localize('media.image.fit', 'Fit to window') : `${scale * 100}%` }));
	lifetime.add(picker.onDidAccept(() => {
		const selection = picker.selectedItems[0];
		if (selection && !viewer.isDisposed) viewer.setScale(selection.scale);
		picker.hide();
	}));
	lifetime.add(picker.onDidHide(() => lifetime.dispose()));
	picker.show();
}

export class SelectImageZoomLevelAction extends Action2 {
	constructor() {
		super({ id: 'imagePreview.selectZoomLevel', title: localize2('media.image.selectZoom', 'Select image zoom level'), f1: true, precondition: ContextKeyExpr.has('imagePreviewFocused') });
	}
	public override run(accessor: ServicesAccessor): void {
		const viewer = getActiveImagePreview(accessor.get(IEditorService).activeEditorPane)?.imageViewer;
		if (viewer?.hasImage) selectImageZoomLevel(viewer, accessor.get(IQuickInputService));
	}
}

export class CopyImageAction extends Action2 {
	constructor() {
		super({ id: 'imagePreview.copyImage', title: localize2('media.image.copy', 'Copy image'), f1: true, precondition: ContextKeyExpr.has('imagePreviewFocused') });
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		await getActiveImagePreview(accessor.get(IEditorService).activeEditorPane)?.imageViewer.copyImage();
	}
}
