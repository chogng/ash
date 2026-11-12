import './media/imagePreviewPopup.css';
import { addDisposableListener, getActiveElement, getWindow, h, isHTMLElement, isNode } from '../../../../base/browser/dom.js';
import { createObjectUrl } from '../../../../base/browser/fileAccess.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { AnchorAlignment, AnchorPosition, ContextViewFocusRestore, type ContextViewAnchor } from '../../../../base/browser/ui/contextview/contextview.js';
import { DropdownMenuActionViewItem } from '../../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js';
import { getHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { MenuActionViewItem, type MenuActionViewItemOptions } from '../../../../base/browser/ui/menu/menu.js';
import { Separator, type IAction } from '../../../../base/common/actions.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import type { Icon } from '../../../../base/common/icon.js';
import { DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
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
import { ImageViewer, type ImageViewerScale, type IImageViewerSourceOptions } from './imageViewer.js';
import { resourceFileName, saveResourceAs } from '../../../services/files/browser/resourceSave.js';

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
	readonly gallery?: IImagePreviewGallery;
}

export interface IImagePreviewGallery {
	readonly index: number;
	readonly labels: readonly string[];
	readImage(index: number): Promise<Blob>;
	onClose(index: number, restoreFocus: boolean): void;
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
	private iconSource: string | null | undefined;

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
		// Keep the displayed icon until discovery and decoding of its replacement finish.
		if (application === undefined) return;
		const iconSource = application?.icon ?? null;
		if (iconSource === this.iconSource) return;
		this.iconSource = iconSource;
		if (!iconSource) {
			slot.replaceChildren();
			appendIcon(Lxicon.openInProduct, slot);
			return;
		}
		const icon = h(slot.ownerDocument, 'img', {
			className: 'ash-image-preview-app-icon',
			properties: { src: iconSource, alt: '', draggable: false },
		});
		void icon.decode().then(() => {
			if (!this.isDisposed && this.iconSource === iconSource) slot.replaceChildren(icon);
		}, () => {
			if (this.isDisposed || this.iconSource !== iconSource) return;
			slot.replaceChildren();
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
		@IContextMenuService private readonly menus: IContextMenuService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@INotificationService private readonly notifications: INotificationService,
		@IHostService private readonly host: IHostService,
		@IWebWorkerService private readonly workers: IWebWorkerService,
	) {
		const document = isNode(anchor) ? anchor.ownerDocument : contextViews.container.ownerDocument;
		const gallery = source.gallery;
		let selected = gallery?.index ?? 0;
		let name = source.name;
		const frame = this.frame = h(document, 'div', {
			className: 'ash-image-preview-popup',
			attributes: { role: 'dialog', 'aria-label': localize('media.image.previewNamed', 'Preview {0}', name) },
		});
		const title = h(document, 'span', {}, name);
		resources.add(getHoverDelegate().setupDelayedHover(title, () => ({
			content: title.scrollWidth > title.clientWidth ? name : '',
		})));
		const header = h(document, 'div', { className: 'ash-image-preview-popup-header' }, title);
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
			gallery?.onClose(selected, getActiveElement(document) === anchor);
			onHide();
		};
		const viewport = h(document, 'div', { className: 'ash-image-preview-popup-viewport' });
		frame.append(header, viewport);
		const { viewer, load, clear, reportError } = this.renderPreview(source, actions, viewport, resources, target, hide);
		void load(source).catch(reportError);
		if (gallery && gallery.labels.length > 1) {
			const stage = h(document, 'div', { className: 'ash-image-preview-gallery' });
			viewport.replaceWith(stage);
			const controls = h(document, 'div', { className: 'ash-image-preview-gallery-controls' });
			const pagination = h(document, 'div', {
				className: 'ash-image-preview-gallery-pagination',
				attributes: { role: 'group', 'aria-label': localize('media.image.galleryPagination', 'Choose an image') },
			});
			const position = h(document, 'span', { className: 'ash-aria-live', attributes: { role: 'status', 'aria-atomic': 'true' } });
			const status = h(document, 'div', { className: 'ash-image-preview-gallery-message', attributes: { role: 'status' } });
			viewport.append(status);
			stage.append(viewport, controls, pagination, position);
			const pending = resources.add(new MutableDisposable<DisposableStore>());
			const displayedUrl = resources.add(new MutableDisposable<IDisposable>());
			const updateDot = (index: number, current: boolean) => {
				const dot = dots[index]!.domNode;
				dot.classList.toggle('current', current);
				if (current) dot.setAttribute('aria-current', 'true');
				else dot.removeAttribute('aria-current');
			};
			const updateTitle = (index: number, label: string) => {
				name = label;
				title.textContent = name;
				frame.setAttribute('aria-label', localize('media.image.previewNamed', 'Preview {0}', name));
				position.textContent = localize('media.image.galleryPosition', 'Image {0} of {1}: {2}', index + 1, gallery.labels.length, name);
			};
			const select = async (index: number, step = index - selected) => {
				if (index === selected) return;
				updateDot(selected, false);
				selected = index;
				updateDot(index, true);
				const label = gallery.labels[index]!;
				viewer.cancelPendingSource();
				const current = pending.value = new DisposableStore();
				status.textContent = '';
				disposableTimeout(() => { status.textContent = localize('media.image.galleryLoading', 'Loading image…'); }, 200, current);
				try {
					const blob = index === gallery.index && source.blob ? source.blob : await gallery.readImage(index);
					if (current.isDisposed) return;
					const { url, registration } = createObjectUrl(getWindow(document), blob);
					current.add(registration);
					// The viewer keeps the current image until decoding the new source succeeds.
					if (!await load({ name: label, blob, url: url.href }, step < 0 ? 'left' : 'right') || current.isDisposed) return;
					current.delete(registration);
					displayedUrl.value = registration;
					pending.clear();
					status.textContent = '';
					updateTitle(index, label);
				} catch {
					if (current.isDisposed) return;
					clear();
					displayedUrl.clear();
					pending.clear();
					updateTitle(index, label);
					status.textContent = localize('media.image.galleryUnavailable', 'This image is unavailable.');
				}
			};
			const dots = gallery.labels.map((label, index) => {
				const title = localize('media.image.gallerySelect', 'Show image {0}: {1}', index + 1, label);
				return resources.add(new Button(pagination, {
					...defaultButtonStyles, label: '', ariaLabel: title, title, size: 'small',
					onClick: () => { void select(index); },
				}));
			});
			updateDot(selected, true);
			const nextIndex = (step: number) => (selected + step + gallery.labels.length) % gallery.labels.length;
			const previousLabel = localize('media.image.galleryPrevious', 'Previous image');
			const nextLabel = localize('media.image.galleryNext', 'Next image');
			const navigation = resources.add(new WorkbenchToolBar(controls, menus, {
				ariaLabel: localize('media.image.galleryNavigation', 'Image navigation'), tabNavigation: 'each-action',
			}));
			navigation.setActions([
				{ id: 'imagePreview.previousImage', label: previousLabel, tooltip: previousLabel, icon: Lxicon.chevronLeft, enabled: true, run: () => select(nextIndex(-1), -1) },
				{ id: 'imagePreview.nextImage', label: nextLabel, tooltip: nextLabel, icon: Lxicon.chevronRight, enabled: true, run: () => select(nextIndex(1), 1) },
			]);
			resources.add(addDisposableListener(frame, 'keydown', event => {
				if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
				// The file actions keep their own arrow navigation. In the image and
				// gallery controls the same keys change slides without closing the popup.
				const focused = getActiveElement(document);
				if (focused && actions.contains(focused)) return;
				event.preventDefault();
				event.stopPropagation();
				const step = event.key === 'ArrowLeft' ? -1 : 1;
				const index = nextIndex(step);
				void select(index, step);
				if (focused && pagination.contains(focused)) dots[index]!.focus();
			}, true));
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
							? localize('media.image.popupSummary', 'Image preview: {0}\nDimensions: {1} × {2}\nPress Escape or activate Close image preview to return. This view identifies the image; it does not describe its contents.', name, size.width, size.height)
							: localize('media.image.empty', 'No image loaded.');
						const zoom = localize('media.image.popupZoomHelp', 'Open the zoom percentage menu to choose a level or Zoom to fit. In the image viewport, press Plus or Minus to zoom, or 0 to fit. Use Left or Right Arrow to move between image preview actions.');
						const gestures = localize('media.image.popupGesturesHelp', 'In the image viewport, scroll or pinch to zoom. When zoomed in, drag the image or press Shift with an arrow key to pan.');
						const galleryHelp = gallery && gallery.labels.length > 1
							? localize('media.image.popupGalleryHelp', 'Image {0} of {1}. Activate a dot to jump to its image. In the image viewport or gallery controls, press Left or Right Arrow to change images.', selected + 1, gallery.labels.length) : undefined;
						return [summary, zoom, gestures, galleryHelp, target?.accessibleHelp].filter(Boolean).join('\n');
					}, () => { if (focused.isConnected) focused.focus(); }, AccessibilityVerbositySettingId.ImagePreview);
				},
			}));
		}
	}

	private renderPreview(source: IImagePreviewSource, actions: HTMLElement, viewport: HTMLElement, resources: DisposableStore, target: IImagePreviewAnnotationTarget | undefined, hide: () => void) {
		const document = viewport.ownerDocument;
		const { menus, instantiation, notifications, host, workers } = this;
		const annotation = target && resources.add(new ImageAnnotation(document, source.url));
		// The dialog and the viewer's context menu use the same popup host.
		const viewer = resources.add(instantiation.createInstance(ImageViewer, viewport, {
			contextMenu: false,
			overlay: annotation?.overlay,
			wheelZoom: true,
			dragPan: true,
		}));
		const lifetime = new AbortController();
		resources.add(toDisposable(() => lifetime.abort()));
		if (target) resources.add(addDisposableListener(target.signal, 'abort', hide));
		let displayed: IImagePreviewSource | undefined = source;
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
		const openImage = (source.blob || source.gallery) && host.openImage?.bind(host);
		const listApps = openImage && host.listImageOpeningApplications?.bind(host);
		let openItem: ImageOpenActionViewItem | undefined;
		let selectedApp: IImageOpeningApplication | undefined;
		let defaultApp: IImageOpeningApplication | null | undefined;
		const applicationsByFormat = new Map<ImageOpenExtension, Promise<readonly IImageOpeningApplication[]>>();
		let applications: Promise<readonly IImageOpeningApplication[]> | undefined;
		const updateApplications = (image: Blob | undefined) => {
			if (!listApps) return;
			const format = image && (nativeImageFormats.get(image.type) ?? 'png');
			let request = format && applicationsByFormat.get(format);
			if (format && !request) {
				request = listApps(format).catch(() => []).then(apps => {
					const systemDefault = apps.find(app => app.isDefault);
					return systemDefault ? [systemDefault, ...apps.filter(app => app.id !== systemDefault.id)] : apps;
				});
				applicationsByFormat.set(format, request);
			}
			if (applications === request) return;
			applications = request;
			selectedApp = undefined;
			defaultApp = undefined;
			openItem?.refreshApplication();
			void request?.then(apps => {
				if (lifetime.signal.aborted || applications !== request) return;
				defaultApp = apps.find(app => app.isDefault) ?? null;
				openItem?.refreshApplication();
			});
		};
		const open = async (applicationId?: string) => {
			const image = displayed?.blob;
			if (!openImage || !displayed || !image) return;
			const name = resourceFileName(displayed.name, image.type);
			try {
				const bytes = nativeImageFormats.has(image.type)
					? new Uint8Array(await image.arrayBuffer())
					: await encodeImageBlobAsPng(image, document, workers);
				await openImage(bytes, applicationId);
			} catch (error) {
				throw new Error(localize('media.image.openFailed', 'Could not open {0}: {1}', name, String(error)), { cause: error });
			}
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
					}, { ...options, buttonClassName: 'ash-image-preview-zoom' }, () => ({ anchorAlignment: AnchorAlignment.Right }));
				}
				if (action.id === openId && listApps) {
					// The provider supplies the actual menu actions once app discovery finishes.
					return openItem = new ImageOpenActionViewItem(() => selectedApp ?? defaultApp, action, openDropdown, [openDropdown], {
						showContextMenu: delegate => {
							const request = applications;
							if (!request) {
								delegate.onHide?.(true);
								return;
							}
							const pending = delegate.cancellationToken?.onCancellationRequested(() => delegate.onHide?.(true));
							void request.then(apps => {
								pending?.dispose();
								if (delegate.cancellationToken?.isCancellationRequested) return;
								if (request !== applications || lifetime.signal.aborted) {
									delegate.onHide?.(true);
									return;
								}
								const icons = new Map<string, string>();
								const selectedId = (selectedApp ?? defaultApp)?.id;
								const appActions = apps.map((application): IAction => {
									const id = `imagePreview.open.${application.id}`;
									if (application.icon) icons.set(id, application.icon);
									return {
										id, label: application.name, tooltip: '', enabled: true,
										icon: application.icon ? undefined : Lxicon.openInProduct,
										checked: selectedId === application.id,
										run: () => {
											if (request === applications) selectApp(application.isDefault ? undefined : application);
										},
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
		const zoom: IAction = { id: zoomId, get label() { return zoomLabel; }, tooltip: '', enabled: true, run: () => { } };
		const loadingZoom = { ...zoom, enabled: false };
		resources.add(viewer.onDidFailCopy(reportError));
		const save = action('imagePreview.save', localize('media.image.save', 'Save image'), Lxicon.download, () => {
			if (!displayed?.blob) return;
			const { blob, name } = displayed;
			return instantiation.invokeFunction(saveResourceAs, blob, resourceFileName(name, blob.type), document);
		});
		const fileActions = [save];
		if (openImage) fileActions.push(action(openId, localize('media.image.open', 'Open'), listApps ? undefined : Lxicon.openInProduct, () => open(selectedApp?.id)));
		let draw: IAction | undefined;
		let loadingDraw: IAction | undefined;
		const previewActions = () => {
			const actions = [viewer.hasImage ? zoom : loadingZoom, ...(displayed?.blob ? fileActions : [])];
			const annotationAction = viewer.hasImage ? draw : loadingDraw;
			if (annotationAction) actions.push(annotationAction);
			return actions;
		};
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
				toolbar.setActions(active ? [zoom] : previewActions());
				annotationActions.hidden = !active;
				update();
			};
			const update = () => {
				undo.enabled = editing && annotation.hasStrokes && !busy;
				done.enabled = undo.enabled;
				cancel.enabled = !busy;
			};
			draw = action('imagePreview.annotate', localize('media.image.annotate', 'Annotate image'), Lxicon.edit, () => {
				if (!viewer.naturalSize) return;
				annotation.start(viewer.naturalSize);
				toggle(true);
				viewer.domNode.focus();
			});
			const undo = button(localize('media.image.undoStroke', 'Undo stroke'), () => annotation.undo());
			const cancel = button(localize('media.image.cancelAnnotation', 'Cancel annotation'), () => {
				annotation.clear();
				toggle(false);
				toolbar.focus(draw ? previewActions().indexOf(draw) : -1);
			});
			const done = button(localize('media.image.doneAnnotating', 'Done annotating'), async () => {
				if (busy || !annotation.hasStrokes) return;
				busy = true;
				annotation.overlay.style.pointerEvents = 'none';
				update();
				try {
					const blob = await annotation.renderPng(lifetime.signal);
					const name = source.blob ? resourceFileName(source.name, source.blob.type) : source.name;
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
			loadingDraw = { ...draw, enabled: false };
			update();
			resources.add(annotation.onDidChange(update));
		}
		// Retain the action views across gallery changes; actions read the image currently on screen.
		const updateDisplayed = (next: IImagePreviewSource | undefined, wasReady: boolean) => {
			const hadBlob = !!displayed?.blob;
			displayed = next;
			if (wasReady !== viewer.hasImage || hadBlob !== !!next?.blob) toolbar.setActions(previewActions());
			updateZoomLabel();
			updateApplications(next?.blob);
		};
		updateApplications(source.blob);
		toolbar.setActions(previewActions());
		return {
			viewer, reportError,
			load: async (next: IImagePreviewSource, slideFrom?: IImageViewerSourceOptions['slideFrom']) => {
				const wasReady = viewer.hasImage;
				const image = next.blob;
				const data = image && { mimeType: image.type, read: async () => new Uint8Array(await image.arrayBuffer()) };
				if (!await viewer.setSource(next.url, { alt: next.name, data, slideFrom }) || lifetime.signal.aborted) return false;
				updateDisplayed(next, wasReady);
				return true;
			},
			clear: () => {
				const wasReady = viewer.hasImage;
				viewer.clear();
				zoomLabel = selectZoom;
				updateDisplayed(undefined, wasReady);
			},
		};
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
