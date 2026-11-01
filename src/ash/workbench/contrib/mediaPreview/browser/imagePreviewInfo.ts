import { h, isHTMLElement } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { AnchorAlignment, AnchorPosition, ContextViewFocusRestore } from '../../../../base/browser/ui/contextview/contextview.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ImagePreviewConfiguration } from '../common/mediaPreview.js';
import type { ImagePreviewEditor } from './imagePreviewEditor.js';
import './media/imagePreviewInfo.css';

/** Owns the image details surface; the shared context view owns placement and dismissal. */
export class ImagePreviewInfo extends Disposable {
	private readonly domNode: HTMLElement;
	private readonly values: HTMLElement[] = [];
	private readonly feedback: HTMLElement;
	private shown = false;

	constructor(
		public readonly preview: ImagePreviewEditor,
		private readonly anchor: HTMLElement,
		private readonly onClose: () => void,
		@IContextViewService private readonly contextViews: IContextViewService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
	) {
		super();
		const document = anchor.ownerDocument;
		const root = this.domNode = h(document, 'div', { className: 'ash-image-preview-info' });
		root.id = createUuid();
		root.tabIndex = -1;
		root.setAttribute('role', 'dialog');
		root.setAttribute('aria-modal', 'false');
		const title = localize('media.image.infoTitle', 'Image information');
		const hint = accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.ImagePreview);
		root.setAttribute('aria-label', [title, hint].filter(Boolean).join('. '));
		const header = h(document, 'div', { className: 'ash-image-preview-info-header' });
		const heading = h(document, 'h3');
		heading.textContent = title;
		header.append(heading);
		this._register(new Button(header, {
			...defaultButtonStyles, label: '', icon: Lxicon.close, iconOnly: true, size: 'small',
			ariaLabel: localize('media.image.closeInfo', 'Close image information'),
			onClick: () => this.contextViews.hide(),
		}));
		const details = h(document, 'dl');
		for (const label of [
			localize('media.image.fileName', 'File name'),
			localize('media.image.format', 'Format'),
			localize('media.image.dimensions', 'Dimensions'),
			localize('media.image.fileSize', 'File size'),
		]) {
			const term = h(document, 'dt');
			term.textContent = label;
			const value = h(document, 'dd');
			this.values.push(value);
			details.append(term, value);
		}
		const actions = h(document, 'div', { className: 'ash-image-preview-info-actions' });
		this._register(new Button(actions, {
			...defaultButtonStyles, label: localize('media.image.copyDimensions', 'Copy dimensions'),
			onClick: () => { void this.copy(true); },
		}));
		this._register(new Button(actions, {
			...defaultButtonStyles, label: localize('media.image.copyInfo', 'Copy image information'),
			onClick: () => { void this.copy(false); },
		}));
		this._register(new Button(actions, {
			...defaultButtonStyles, label: localize('media.image.hideInfo', 'Hide image information'),
			onClick: () => { void this.hideInformation(); },
		}));
		this.feedback = h(document, 'div', { className: 'ash-image-preview-info-feedback' });
		this.feedback.setAttribute('role', 'status');
		this.feedback.setAttribute('aria-atomic', 'true');
		root.append(header, details, actions, this.feedback);
		this._register(preview.onDidChangeImageInfo(() => this.update()));
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, priority: 105, name: `imagePreviewInfo.${root.id}.${type}`,
				getProvider: () => {
					const focused = document.activeElement;
					if (!focused || !root.contains(focused)) { return undefined; }
					return new AccessibleContentProvider(AccessibleViewProviderId.ImagePreview, { type },
						() => type === AccessibleViewType.View ? this.informationText() : localize('media.image.infoHelp', 'Image information shows the file name, format, original dimensions and file size. Use Tab to reach Copy dimensions, Copy image information, Hide image information and Close. Hiding information saves the setting and keeps the zoom button available. Press Escape to close and return to the status bar.'),
						() => {
							if (isHTMLElement(focused) && focused.isConnected) { focused.focus(); }
						}, AccessibilityVerbositySettingId.ImagePreview);
				},
			}));
		}
		this.update();
	}

	public get visible(): boolean { return this.shown; }

	public show(): void {
		if (this.isDisposed || !this.preview.imageInfo) { return; }
		this.anchor.focus();
		this.shown = this.contextViews.show({
			anchor: this.anchor, content: this.domNode,
			anchorPosition: AnchorPosition.Above, anchorAlignment: AnchorAlignment.Right,
			presentation: 'default', focusRestore: ContextViewFocusRestore.Previous,
			onHide: () => {
				this.shown = false;
				this.dispose();
				this.onClose();
			},
		});
		if (this.shown) { this.domNode.focus({ preventScroll: true }); }
	}

	private update(): void {
		const info = this.preview.imageInfo;
		if (!info) {
			if (this.shown) { this.contextViews.hide(); }
			return;
		}
		const values = [
			info.name,
			info.mediaType,
			localize('media.image.pixelDimensions', '{0} × {1} pixels', info.width, info.height),
			localize('media.image.bytes', '{0} bytes', info.fileSize),
		];
		for (let index = 0; index < values.length; index++) { this.values[index].textContent = values[index]; }
	}

	private informationText(): string {
		const info = this.preview.imageInfo;
		return info ? localize('media.image.infoContent', 'File name: {0}\nFormat: {1}\nDimensions: {2} × {3} pixels\nFile size: {4} bytes', info.name, info.mediaType, info.width, info.height, info.fileSize) : '';
	}

	private async copy(dimensionsOnly: boolean): Promise<void> {
		const info = this.preview.imageInfo;
		if (!info) { return; }
		try {
			await this.clipboard.writeText(dimensionsOnly ? `${info.width} × ${info.height}` : this.informationText());
			if (!this.isDisposed) {
				this.feedback.setAttribute('role', 'status');
				this.feedback.textContent = localize('media.image.infoCopied', 'Copied to clipboard.');
			}
		} catch (error) { this.showError(error); }
	}

	private async hideInformation(): Promise<void> {
		try {
			await this.configuration.updateValue(ImagePreviewConfiguration.showImageInfo, false);
			if (!this.isDisposed && this.shown) { this.contextViews.hide(); }
			if (!this.preview.isDisposed) { this.preview.focus(); }
		} catch (error) { this.showError(error); }
	}

	private showError(error: unknown): void {
		if (this.isDisposed) { return; }
		this.feedback.setAttribute('role', 'alert');
		this.feedback.textContent = localize('media.image.infoActionFailed', 'Could not complete the action: {0}', error instanceof Error ? error.message : String(error));
	}

	protected override disposeCore(): void {
		if (this.shown) { this.contextViews.hide(); }
		super.disposeCore();
	}
}
