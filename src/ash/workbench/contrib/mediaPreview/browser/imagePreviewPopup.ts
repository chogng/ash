import './media/imagePreviewPopup.css';
import { addDisposableListener, getActiveElement, getWindow, h, isHTMLElement, isNode } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { AnchorAlignment, AnchorPosition, ContextViewFocusRestore, type ContextViewAnchor } from '../../../../base/browser/ui/contextview/contextview.js';
import { DropdownMenuActionViewItem } from '../../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { MenuActionViewItem, type MenuActionViewItemOptions } from '../../../../base/browser/ui/menu/menu.js';
import { Separator, type IAction } from '../../../../base/common/actions.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import type { Icon } from '../../../../base/common/icon.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { extname } from '../../../../base/common/path.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { DropdownWithPrimaryActionViewItem } from '../../../../platform/actions/browser/dropdownWithPrimaryActionViewItem.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { IImageOpeningApplication, ImageOpenExtension } from '../../../../platform/opener/common/opener.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IWebWorkerService } from '../../../../platform/webWorker/browser/webWorkerService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { ImageAnnotation } from './imageAnnotation.js';
import { encodeImageBlobAsPng } from './imageEncoder.js';
import { ImageViewer, type ImageViewerScale } from './imageViewer.js';
import { mediaImageFileName, saveMediaImageAs } from './mediaPreviewSaveAs.js';

export interface IImagePreviewAnnotationTarget {
	readonly signal: AbortSignal;
	readonly accessibleHelp?: string;
	attach(file: File, signal: AbortSignal): Promise<void>;
	focus(): void;
}

interface IImagePreviewSource {
	readonly name: string;
	readonly url: string;
	readonly blob?: Blob;
}

const nativeImageFormats = new Map<string, ImageOpenExtension>([
	['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/webp', 'webp'],
]);

class ImageApplicationMenuItem extends MenuActionViewItem {
	constructor(action: IAction, options: MenuActionViewItemOptions, private readonly appIcon: string) {
		super(action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		this.iconSlot?.append(h(container.ownerDocument, 'img', {
			className: 'ash-image-preview-app-icon',
			properties: { src: this.appIcon, alt: '', draggable: false },
		}));
	}
}

class ImageOpenActionViewItem extends DropdownWithPrimaryActionViewItem {
	private iconSlot: HTMLElement | undefined;

	constructor(
		private readonly getApplication: () => IImageOpeningApplication | null | undefined,
		...args: ConstructorParameters<typeof DropdownWithPrimaryActionViewItem>
	) {
		super(...args);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		const button = this.primaryButton!;
		this.iconSlot = h(button.ownerDocument, 'span', {
			className: 'ash-image-preview-app-icon-slot',
			attributes: { 'aria-hidden': 'true' },
		});
		button.prepend(this.iconSlot);
		this.refreshApplication();
	}

	refreshApplication(): void {
		const slot = this.iconSlot;
		if (this.isDisposed || !slot || !this.primaryButton) return;
		const application = this.getApplication();
		this.primaryButton.setAttribute('aria-label', application
			? localize('media.image.openWithApp', 'Open with {0}', application.name)
			: this.action.label);
		slot.replaceChildren();
		// Leave the slot empty while discovering the default application.
		if (application === undefined) return;
		if (!application?.icon) {
			appendIcon(Lxicon.openInProduct, slot);
			return;
		}
		const icon = h(slot.ownerDocument, 'img', {
			className: 'ash-image-preview-app-icon',
			properties: { src: application.icon, alt: '', draggable: false, hidden: true },
		});
		slot.append(icon);
		void icon.decode().then(() => {
			if (!this.isDisposed && icon.parentElement === slot) icon.hidden = false;
		}, () => {
			if (this.isDisposed || icon.parentElement !== slot) return;
			icon.remove();
			appendIcon(Lxicon.openInProduct, slot);
		});
	}
}

/** Anchored image preview shared by resource and attachment entry points. */
export class ImagePreviewPopup {
	private readonly frame: HTMLElement;
	private readonly close: Button;
	private visible = false;
	private readonly onHide: () => void;

	constructor(
		source: IImagePreviewSource,
		private readonly anchor: ContextViewAnchor,
		resources: DisposableStore,
		target: IImagePreviewAnnotationTarget | undefined,
		onHide: () => void,
		@IContextViewService private readonly contextViews: IContextViewService,
		@IContextMenuService menus: IContextMenuService,
		@IInstantiationService instantiation: IInstantiationService,
		@INotificationService notifications: INotificationService,
		@IHostService host: IHostService,
		@IWebWorkerService workers: IWebWorkerService,
	) {
		const { blob: image, url: src } = source;
		const document = isNode(anchor) ? anchor.ownerDocument : contextViews.container.ownerDocument;
		const frame = this.frame = h(document, 'div', {
			className: 'ash-image-preview-popup',
			attributes: { role: 'dialog', 'aria-label': localize('media.image.previewNamed', 'Preview {0}', source.name) },
		});
		const header = h(document, 'div', { className: 'ash-image-preview-popup-header' },
			h(document, 'span', {}, source.name));
		const actions = h(document, 'div', { className: 'ash-image-preview-popup-actions' });
		header.append(actions);
		this.close = resources.add(new Button(header, {
			...defaultButtonStyles, label: localize('media.image.closePreview', 'Close image preview'),
			icon: Lxicon.close, iconOnly: true, size: 'small', presentation: 'quiet',
		}));
		const hide = () => { if (this.visible) contextViews.hide(); };
		resources.add(this.close.onDidClick(hide));
		resources.add(toDisposable(hide));
		this.onHide = () => {
			this.visible = false;
			onHide();
		};
		const viewport = h(document, 'div', { className: 'ash-image-preview-popup-viewport' });
		frame.append(header, viewport);
		const annotation = target && resources.add(new ImageAnnotation(document, src));
		// The dialog and the viewer's context menu use the same popup host.
		const viewer = resources.add(instantiation.createInstance(ImageViewer, viewport, { contextMenu: false, overlay: annotation?.overlay }));
		const lifetime = new AbortController();
		resources.add(toDisposable(() => lifetime.abort()));
		if (target) resources.add(addDisposableListener(target.signal, 'abort', hide));
		const read = image && (async () => new Uint8Array(await image.arrayBuffer()));
		const name = image ? mediaImageFileName(source.name, image.type) : source.name;
		const reportError = (error: unknown) => {
			if (!lifetime.signal.aborted && !isCancellationError(error)) notifications.error(error instanceof Error ? error : String(error));
		};
		const zoomId = 'imagePreview.zoom';
		const openId = 'imagePreview.openExternal';
		const selectZoom = localize('media.image.selectZoom', 'Select image zoom level');
		const percent = new Intl.NumberFormat(getNLSLanguage(), { style: 'percent' });
		const zoomToFit = localize('media.image.zoomToFit', 'Zoom to fit');
		let zoomLabel = selectZoom;
		let zoomItem: DropdownMenuActionViewItem | undefined;
		const updateZoomLabel = () => zoomItem?.setLabel(zoomLabel, localize('media.image.zoomValue', 'Zoom: {0}', zoomLabel));
		const openFormat = image && nativeImageFormats.get(image.type);
		const openImage = image && host.openImage?.bind(host);
		const listApps = openImage && host.listImageOpeningApplications?.bind(host);
		let openItem: ImageOpenActionViewItem | undefined;
		let selectedApp: IImageOpeningApplication | undefined;
		let defaultApp: IImageOpeningApplication | null | undefined;
		const applications = listApps?.(openFormat ?? 'png').catch(() => []).then(apps => {
			const systemDefault = apps.find(app => app.isDefault);
			defaultApp = systemDefault ?? null;
			if (!lifetime.signal.aborted) openItem?.refreshApplication();
			return systemDefault ? [systemDefault, ...apps.filter(app => app.id !== systemDefault.id)] : apps;
		});
		const open = async (applicationId?: string) => {
			if (!openImage || !image || !read) return;
			try { await openImage(await (openFormat ? read() : encodeImageBlobAsPng(image, document, workers)), applicationId); }
			catch (error) { throw new Error(localize('media.image.openFailed', 'Could not open {0}: {1}', name, String(error)), { cause: error }); }
		};
		const selectApp = (application: IImageOpeningApplication | undefined) => {
			selectedApp = application;
			openItem?.refreshApplication();
		};
		const chooseApp = localize('media.image.chooseApp', 'Choose image app');
		const openDropdown: IAction = { id: 'imagePreview.chooseApp', label: chooseApp, tooltip: chooseApp, enabled: true, run: () => { } };
		const toolbar = resources.add(new WorkbenchToolBar(actions, menus, {
			ariaLabel: localize('media.image.previewActions', 'Image preview actions'),
			tabNavigation: 'each-action',
			actionViewItemProvider: (action, options) => {
				if (action.id === zoomId) {
					return zoomItem = new DropdownMenuActionViewItem(action, () => {
						const selected = viewer.getViewState().scale;
						const zoomAction = (scale: ImageViewerScale, label: string): IAction => ({
							id: `imagePreview.zoom.${scale}`, label, tooltip: '', enabled: true,
							checked: selected === scale, run: () => viewer.setScale(scale),
						});
						return [...[0.25, 0.5, 1, 1.5, 2].map(scale => zoomAction(scale, percent.format(scale))),
						new Separator(), zoomAction('fit', zoomToFit)];
					}, {
						showContextMenu: delegate => menus.showContextMenu({
							...delegate, anchorPosition: AnchorPosition.Below, gap: 4,
							getMenuClassName: () => 'ash-image-preview-popup-menu',
							iconPlacement: 'trailing', getCheckedActionsRepresentation: () => 'radio',
						}),
					}, options, () => ({ anchorAlignment: AnchorAlignment.Right }));
				}
				if (action.id === openId && applications) {
					// The provider supplies the actual menu actions once app discovery finishes.
					return openItem = new ImageOpenActionViewItem(() => selectedApp ?? defaultApp, action, openDropdown, [openDropdown], {
						showContextMenu: delegate => {
							const pending = delegate.cancellationToken?.onCancellationRequested(() => delegate.onHide?.(true));
							void applications.then(apps => {
								pending?.dispose();
								if (delegate.cancellationToken?.isCancellationRequested) return;
								const icons = new Map<string, string>();
								const selectedId = (selectedApp ?? defaultApp)?.id;
								const appActions = apps.map((application): IAction => {
									const id = `imagePreview.open.${application.id}`;
									if (application.icon) icons.set(id, application.icon);
									return {
										id, label: application.name, tooltip: '', enabled: true,
										icon: application.icon ? undefined : Lxicon.openInProduct,
										checked: selectedId === application.id,
										run: () => selectApp(application.isDefault ? undefined : application),
									};
								});
								if (!appActions.length) {
									appActions.push({
										id: 'imagePreview.noApps', label: localize('media.image.noApps', 'No compatible applications'),
										tooltip: '', enabled: false, run: () => { },
									});
								}
								menus.showContextMenu({
									...delegate, anchorPosition: AnchorPosition.Below, gap: 4,
									anchorAlignment: AnchorAlignment.Right,
									getMenuClassName: () => 'ash-image-preview-popup-menu',
									iconPlacement: 'leading-with-trailing-check', getCheckedActionsRepresentation: () => 'radio',
									getActions: () => appActions,
									getActionViewItem: (action, options) => {
										const icon = icons.get(action.id);
										return icon ? new ImageApplicationMenuItem(action, options, icon) : undefined;
									},
								});
							}).catch(error => {
								pending?.dispose();
								delegate.onHide?.(true);
								reportError(error);
							});
						},
					}, options);
				}
				return undefined;
			},
		}));
		resources.add(toolbar.actionRunner.onDidRun(({ error }) => { if (error !== undefined) reportError(error); }));
		resources.add(viewer.onDidChangeDisplayScale(scale => {
			const label = percent.format(scale);
			if (label !== zoomLabel) {
				zoomLabel = label;
				updateZoomLabel();
			}
		}));
		const action = (id: string, label: string, icon: Icon | undefined, run: () => void | Promise<void>): IAction =>
			({ id, label, tooltip: label, icon, enabled: true, run });
		const zoom: IAction[] = [{ id: zoomId, get label() { return zoomLabel; }, tooltip: '', enabled: true, run: () => { } }];
		resources.add(viewer.onDidFailCopy(reportError));
		const fileActions = image ? [action('imagePreview.save', localize('media.image.save', 'Save image'), Lxicon.download,
			() => instantiation.invokeFunction(saveMediaImageAs, image, name, document))] : [];
		if (openImage) fileActions.push(action(openId, localize('media.image.open', 'Open'), applications ? undefined : Lxicon.openInProduct, () => open(selectedApp?.id)));
		const previewActions = [...zoom, ...fileActions];
		const loadingActions = [...zoom.map(item => ({ ...item, enabled: false })), ...fileActions];
		if (annotation && target) {
			let editing = false;
			let busy = false;
			const annotationActions = h(document, 'div', { className: 'ash-image-preview-annotation-actions' });
			annotationActions.hidden = true;
			actions.append(annotationActions);
			const button = (label: string, run: () => void | Promise<void>, presentation: 'quiet' | 'primary' = 'quiet'): Button =>
				resources.add(new Button(annotationActions, {
					...defaultButtonStyles, label, title: label, size: 'small', presentation,
					onClick: () => { void Promise.resolve().then(run).catch(reportError); },
				}));
			const toggle = (active: boolean) => {
				editing = active;
				toolbar.setActions(active ? zoom : previewActions);
				annotationActions.hidden = !active;
				update();
			};
			const update = () => {
				undo.enabled = editing && annotation.hasStrokes && !busy;
				done.enabled = undo.enabled;
				cancel.enabled = !busy;
			};
			const draw = action('imagePreview.annotate', localize('media.image.annotate', 'Annotate image'), Lxicon.edit, () => {
				if (!viewer.naturalSize) return;
				annotation.start(viewer.naturalSize);
				toggle(true);
				viewer.domNode.focus();
			});
			const undo = button(localize('media.image.undoStroke', 'Undo stroke'), () => annotation.undo());
			const cancel = button(localize('media.image.cancelAnnotation', 'Cancel annotation'), () => {
				annotation.clear();
				toggle(false);
				toolbar.focus(previewActions.indexOf(draw));
			});
			const done = button(localize('media.image.doneAnnotating', 'Done annotating'), async () => {
				if (busy || !annotation.hasStrokes) return;
				busy = true;
				annotation.overlay.style.pointerEvents = 'none';
				update();
				try {
					const blob = await annotation.renderPng(lifetime.signal);
					const fileName = `${name.slice(0, name.length - extname(name).length)}-annotated.png`;
					await target.attach(new (getWindow(document).File)([blob], fileName, { type: 'image/png' }), lifetime.signal);
					if (!lifetime.signal.aborted) hide();
					target.focus();
				} finally {
					if (!lifetime.signal.aborted) {
						busy = false;
						annotation.overlay.style.pointerEvents = '';
						update();
					}
				}
			}, 'primary');
			previewActions.push(draw);
			loadingActions.push({ ...draw, enabled: false });
			update();
			resources.add(annotation.onDidChange(update));
		}
		const accessibleViewName = `imagePreviewPopup-${createUuid()}`;
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			resources.add(AccessibleViewRegistry.register({
				name: accessibleViewName, type, priority: 100,
				getProvider: (_, focusTarget) => {
					const focused = focusTarget ?? getActiveElement(document);
					if (!isHTMLElement(focused) || !frame.contains(focused)) return undefined;
					return new AccessibleContentProvider(AccessibleViewProviderId.ImagePreview, { type }, () => {
						const size = viewer.naturalSize;
						const summary = size
							? localize('media.image.popupSummary', 'Image preview: {0}\nDimensions: {1} × {2}\nPress Escape or activate Close image preview to return. This view identifies the image; it does not describe its contents.', source.name, size.width, size.height)
							: localize('media.image.empty', 'No image loaded.');
						const zoom = localize('media.image.popupZoomHelp', 'Open the zoom percentage menu to choose a level or Zoom to fit. In the image viewport, press Plus or Minus to zoom, or 0 to fit. Use Left or Right Arrow to move between image preview actions.');
						return [summary, zoom, target?.accessibleHelp].filter(Boolean).join('\n');
					}, () => { if (focused.isConnected) focused.focus(); }, AccessibilityVerbositySettingId.ImagePreview);
				},
			}));
		}
		toolbar.setActions(loadingActions);
		void viewer.setSource(src, { alt: source.name, data: image && read ? { mimeType: image.type, read } : undefined }).then(loaded => {
			if (loaded && !lifetime.signal.aborted) {
				toolbar.setActions(previewActions);
				updateZoomLabel();
			}
		}).catch(reportError);
	}

	show(): boolean {
		if (!this.contextViews.show({
			anchor: this.anchor, content: this.frame, presentation: 'dialog',
			focusRestore: ContextViewFocusRestore.Previous, onHide: this.onHide,
		})) return false;
		this.visible = true;
		this.close.focus();
		return true;
	}
}
