import { getActiveElement, getWindow, h, addDisposableListener, isHTMLElement, type IDimension } from '../../../../base/browser/dom.js';
import { StandardWheelEvent } from '../../../../base/browser/mouseEvent.js';
import { AnimationFrameScheduler } from '../../../../base/browser/scheduler.js';
import { ZoomAnchor } from '../../../../base/browser/ui/zoom/zoomAnchor.js';
import { clamp } from '../../../../base/common/numbers.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Action } from '../../../../base/common/actions.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Delayer, RunOnceScheduler } from '../../../../base/common/async.js';
import { ButtonActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { DropdownMenuActionViewItem } from '../../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { AnchorAlignment, AnchorPosition, layout2d } from '../../../../base/common/layout.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import type { Icon } from '../../../../base/common/icon.js';
import { basename } from '../../../../base/common/resources.js';
import { UndoCommand, RedoCommand } from '../../../../editor/browser/editorExtensions.js';
import { localize } from '../../../../nls.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { PdfAnnotation, PdfAnnotationEdit, PdfPage, PdfPoint, PdfRect } from '../../../../platform/pdf/common/pdfService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { CopyActionViewItem } from '../../../../workbench/contrib/chat/browser/widget/copyActionViewItem.js';
import type { IEditorPaneWithViewState } from '../../../../workbench/browser/parts/editor/editorWithViewState.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { registerResourceEditorAccessibility } from '../../../../workbench/services/extensions/browser/resourceEditorAccessibility.js';
import { PdfDocumentModel } from './pdfDocumentModel.js';
import { IPdfEditorService } from './pdfEditorService.js';
import { PdfPageView } from './pdfPageView.js';
import { PdfNavigationPane } from './pdfNavigationPane.js';
import { PdfContinuousView } from './pdfContinuousView.js';
import { PdfSelectionActions, type PdfSelectionActionsHost } from './pdfSelectionActions.js';
import { PdfScrollMode, pdfScrollModeSetting } from './pdfPreviewConfiguration.js';
import './media/pdfPreview.css';

type PdfTool = 'ink' | 'eraser' | 'text';
type PdfZoom = 'page' | 'width' | number;

const pdfEditorFocus = new RawContextKey<boolean>('sessions.pdfEditorFocus', false);
const initialRasterDimension = 1600;
const maximumRasterDimension = 2048;

function isReviewAnnotation(annotation: PdfAnnotation): boolean {
	// PDFium includes document navigation links in the page's annotation array.
	return annotation.kind !== 'Link';
}

/** aspdf's Agent Window reader. Native PDF state is a derived snapshot of its working copy. */
export class PdfPreviewEditor extends EditorPane implements IEditorPaneWithViewState {
	public readonly viewStateTypeId = 'sessions.pdfPreview';
	private readonly inputLifetime = this._register(new MutableDisposable<DisposableStore>());
	private readonly pageLifetime = this._register(new MutableDisposable<DisposableStore>());
	private readonly continuousLifetime = this._register(new MutableDisposable<DisposableStore>());
	private continuous: PdfContinuousView | undefined;
	private pagedView!: PdfPageView;
	private activeView!: PdfPageView;
	private readingArea!: HTMLElement;
	private navigationPane!: PdfNavigationPane;
	private navigationToggle!: Button;
	private scrollMode = PdfScrollMode.Paged;
	private pendingViewState = false;
	private viewCreated = false;
	private element!: HTMLElement;
	private surface!: HTMLElement;
	private pageScroll!: ScrollableElement;
	private annotationScroll!: ScrollableElement;
	private annotationPanel!: HTMLElement;
	private stage!: HTMLElement;
	private progress!: HTMLElement;
	private pageInput!: HTMLInputElement;
	private pageCount!: HTMLElement;
	private annotations!: HTMLElement;
	private note!: HTMLTextAreaElement;
	private previous!: Action;
	private next!: Action;
	private saveAction!: Action;
	private highlightAction!: Action;
	private noteAction!: Action;
	private selectionPopup!: HTMLElement;
	private selectionLayout!: AnimationFrameScheduler;
	private selectionActions!: PdfSelectionActions;
	private selectingText = false;
	private selectionDismissed = false;
	private inkAction!: Action;
	private eraserAction!: Action;
	private textAction!: Action;
	private fitAction!: Action;
	private scrollModeAction!: Action;
	private readonly scrollModeActions: Action[] = [];
	private zoom: PdfZoom = 'page';
	private wheelZoomFrame!: AnimationFrameScheduler;
	private wheelZoom: { scale: number; readonly x: ZoomAnchor; readonly y: ZoomAnchor; } | undefined;
	private continuousWheelZoom: { scale: number; x: number; y: number; } | undefined;
	private wheelNavigation: { time: number; readonly direction: number; distance: number; turned: boolean; } | undefined;
	private tool: PdfTool | undefined;
	private stroke: PdfPoint[] | undefined;
	private strokePreview: SVGPolylineElement | undefined;
	private pointerId: number | undefined;
	private keyboardPoint: PdfPoint = { x: 0.5, y: 0.5 };
	private readonly eraseLifetime = this._register(new MutableDisposable<DisposableStore>());
	private readonly textLifetime = this._register(new MutableDisposable<DisposableStore>());
	private model: PdfDocumentModel | undefined;
	private displayedPage: PdfPage | undefined;
	private renderedDimension = initialRasterDimension;
	private pageRender: { readonly controller: AbortController; readonly refinement: boolean; readonly scrollBeforeTurn: { left: number; top: number; }; } | undefined;
	private pagePaint: Promise<void> | undefined;
	private readonly pageTurnDelay = this._register(new Delayer<void>(90));
	private readonly zoomRefinement = this._register(new RunOnceScheduler(() => this.refineZoom(), 160));
	private pageNumber = 1;
	private busy = false;
	private savedPage = 1;
	public get workingCopy(): PdfDocumentModel | undefined { return this.model; }

	constructor(
		public readonly id: string,
		@IPdfEditorService private readonly editors: IPdfEditorService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@INotificationService private readonly notifications: INotificationService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
	) { super(id, theme, storage); }

	public override create(parent: HTMLElement): void {
		const document = parent.ownerDocument;
		this.element = h(document, 'section', { className: 'ash-sessions-pdf-preview' });
		this._register(toDisposable(() => this.element.remove()));
		const controls = h(document, 'div', { className: 'ash-editor-pane-toolbar ash-sessions-pdf-controls', attributes: { role: 'group', 'aria-label': localize('sessions.pdfPreview.controls', 'PDF controls') } });
		const navigation = h(document, 'div', { className: 'ash-sessions-pdf-navigation' });
		controls.append(navigation);
		const navigationLabel = localize('sessions.pdfPreview.pageNavigation', 'PDF page navigation');
		this.navigationToggle = this._register(new Button(navigation, {
			...defaultButtonStyles,
			label: navigationLabel,
			title: navigationLabel,
			icon: Lxicon.listUnordered,
			iconOnly: true,
			enabled: false,
			onClick: () => this.setNavigationPaneVisible(this.navigationPane.domNode.hidden === true),
		}));
		this.navigationToggle.domNode.setAttribute('aria-expanded', 'false');
		this.previous = this.action('previous', localize('sessions.pdfPreview.previous', 'Previous page'), Lxicon.chevronLeft, () => this.showPage(this.pageNumber - 1), false);
		this.toolbar(navigation, [this.previous], localize('sessions.pdfPreview.previous', 'Previous page'));
		const pages = h(document, 'div', { className: 'ash-sessions-pdf-pagination' });
		this.pageInput = h(document, 'input', { className: 'ash-sessions-pdf-page-number', properties: { type: 'text', inputMode: 'numeric', value: '1' }, attributes: { 'aria-label': localize('sessions.pdfPreview.pageNumber', 'Page number') } });
		this.pageCount = h(document, 'span', { properties: { textContent: '/–' }, attributes: { 'aria-hidden': 'true' } });
		pages.append(this.pageInput, this.pageCount);
		navigation.append(pages);
		const commitPage = () => {
			const value = this.pageInput.value.trim();
			const number = Number(value);
			if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > (this.displayedPage?.pageCount ?? 0)) {
				this.pageInput.value = String(this.pageNumber);
				status(localize('sessions.pdfPreview.invalidPage', 'Enter a page number between 1 and {0}.', this.displayedPage?.pageCount ?? 1));
				return;
			}
			if (number !== this.pageNumber) { void this.showPage(number); }
		};
		this._register(addDisposableListener(this.pageInput, 'change', commitPage));
		this._register(addDisposableListener(this.pageInput, 'keydown', event => {
			if (event.key === 'Enter') { event.preventDefault(); commitPage(); }
			if (event.key === 'Escape') { event.preventDefault(); this.pageInput.value = String(this.pageNumber); this.pageInput.select(); }
		}));
		this.next = this.action('next', localize('sessions.pdfPreview.next', 'Next page'), Lxicon.chevronRight, () => this.showPage(this.pageNumber + 1), false);
		this.toolbar(navigation, [this.next], localize('sessions.pdfPreview.next', 'Next page'));
		this.highlightAction = this.action('highlight', localize('sessions.pdfPreview.highlight', 'Highlight selection'), Lxicon.editLine, () => this.highlight(this.note.value));
		this.noteAction = this.action('note', localize('sessions.pdfPreview.addNote', 'Add note'), Lxicon.note, () => this.edit({ kind: 'note', bounds: { x: 0.05, y: 0.05, width: 0.04, height: 0.04 }, contents: this.note.value }));
		this.inkAction = this.action('ink', localize('sessions.pdfPreview.draw', 'Draw'), Lxicon.editWrite, () => this.selectTool('ink'));
		this.eraserAction = this.action('eraser', localize('sessions.pdfPreview.erase', 'Erase highlights and drawings'), Lxicon.eraser, () => this.selectTool('eraser'));
		this.textAction = this.action('text', localize('sessions.pdfPreview.addText', 'Add text box'), Lxicon.text, () => this.selectTool('text'));
		const markup = h(document, 'div', { className: 'ash-sessions-pdf-markup' });
		this.toolbar(markup, [this.noteAction, this.highlightAction, this.inkAction, this.eraserAction, this.textAction], localize('sessions.pdfPreview.annotations', 'PDF annotations'));
		controls.append(markup);
		this.fitAction = this.action('fit', localize('sessions.pdfPreview.fitPage', 'Fit page'), Lxicon.screenNormal, () => this.setZoom(this.zoom === 'page' ? 'width' : 'page'), false);
		this.scrollModeAction = this.action('scrollMode', localize('sessions.pdfPreview.scrollMode', 'Scroll mode'), Lxicon.file, () => undefined, false);
		for (const [mode, label, icon] of [
			[PdfScrollMode.Continuous, localize('sessions.pdfPreview.continuous', 'Continuous scrolling'), Lxicon.files],
			[PdfScrollMode.Paged, localize('sessions.pdfPreview.paged', 'Page scrolling'), Lxicon.file],
		] as const) {
			this.scrollModeActions.push(this.action(mode, label, icon, async () => {
				try { await this.configuration.updateValue(pdfScrollModeSetting, mode, ConfigurationTarget.USER_LOCAL); }
				catch (error) { this.showError(error); }
			}, false));
		}
		this.saveAction = this.action('save', localize('sessions.pdfPreview.save', 'Save changes'), Lxicon.save, () => this.save());
		const documentActions = h(document, 'div', { className: 'ash-sessions-pdf-document-actions' });
		this.toolbar(documentActions, [this.fitAction, this.scrollModeAction, this.saveAction], localize('sessions.pdfPreview.documentActions', 'PDF document actions'));
		controls.append(documentActions);
		this.progress = h(document, 'span', { className: 'ash-sessions-pdf-status', attributes: { role: 'status' } });
		controls.append(this.progress);
		const content = h(document, 'div', { className: 'ash-sessions-pdf-content' });
		this.navigationPane = this._register(new PdfNavigationPane(document,
			(number, signal) => this.model!.renderThumbnail(number, signal),
			signal => this.model!.readOutline(signal),
			number => {
				if (number !== this.pageNumber) { void this.showPage(number); }
			},
			target => { void this.showPage(target.page, initialRasterDimension, false, target.top ?? 0); },
			() => {
				this.setNavigationPaneVisible(false);
				this.navigationToggle.focus();
			},
			message => this.notifications.error(message),
		));
		this.navigationToggle.domNode.setAttribute('aria-controls', this.navigationPane.domNode.id);
		this.readingArea = h(document, 'div', { className: 'ash-sessions-pdf-reading-area' });
		content.append(h(document, 'div', { className: 'ash-sessions-pdf-pages' }, this.navigationPane.domNode, this.readingArea));
		this.pageScroll = this._register(new ScrollableElement(this.readingArea, {
			direction: 'both', vertical: 'auto', horizontal: 'auto',
			ariaLabel: localize('sessions.pdfPreview.documentPage', 'PDF page'),
			handleMouseWheel: false,
		}));
		this.surface = this.pageScroll.element;
		this.surface.classList.add('ash-sessions-pdf-page');
		pdfEditorFocus.bindTo(this._register(this.contextKeys.createScoped(this.element))).set(true);
		for (const key of [KeyCode.Equal, KeyMod.Shift | KeyCode.Equal, KeyCode.Minus, KeyCode.NumpadAdd, KeyCode.NumpadSubtract, KeyCode.Digit0]) {
			for (const modifier of [KeyMod.CtrlCmd, KeyMod.WinCtrl]) {
				this._register(KeybindingsRegistry.registerKeybindingPassThrough({ keybinding: modifier | key, when: pdfEditorFocus.isEqualTo(true), priority: KeybindingWeight.WorkbenchContrib + 10 }));
			}
		}
		this.wheelZoomFrame = this._register(new AnimationFrameScheduler(getWindow(this.surface), () => this.flushWheelZoom()));
		// Consume modified input before the shared scroll owner or Chromium handles it.
		this._register(addDisposableListener(this.readingArea, 'wheel', event => {
			if (!event.ctrlKey && !event.metaKey) {
				this.flushWheelZoom();
				this.handlePageWheel(event);
				return;
			}
			this.wheelNavigation = undefined;
			const viewport = this.continuous?.viewport ?? this.pageScroll.scrollableElement;
			const wheel = new StandardWheelEvent(event, { pageWidth: viewport.clientWidth, pageHeight: viewport.clientHeight });
			wheel.stop();
			if (!this.busy && !this.stroke && wheel.deltaY !== 0) { this.queueWheelZoom(wheel); }
		}, { capture: true, passive: false }));
		this._register(addDisposableListener(this.readingArea, 'pointerdown', () => this.flushWheelZoom(), true));
		this._register(this.pageScroll.onDidScroll(() => this.flushWheelZoom()));
		this.pageScroll.contentElement.classList.add('ash-sessions-pdf-sheet');
		this.pagedView = this._register(this.createPageView());
		this.activeView = this.pagedView;
		this.stage = this.pagedView.domNode;
		this._register(addDisposableListener(this.readingArea, 'keydown', event => this.handlePageKeydown(event), true));
		const observer = new ResizeObserver(() => { this.flushWheelZoom(); this.updateZoom(); this.restorePendingViewState(); });
		observer.observe(this.readingArea);
		this._register(toDisposable(() => observer.disconnect()));
		this.pageScroll.append(this.stage);
		this.createSelectionToolbar();
		const sidebar = this.annotationPanel = h(document, 'aside', { className: 'ash-sessions-pdf-annotation-panel', attributes: { 'aria-label': localize('sessions.pdfPreview.annotations', 'PDF annotations') } });
		sidebar.hidden = true;
		this.note = h(document, 'textarea', { properties: { maxLength: 8192, rows: 3 }, attributes: { 'aria-label': localize('sessions.pdfPreview.noteText', 'Annotation text') } });
		this.annotationScroll = this._register(new ScrollableElement(sidebar, { direction: 'vertical', vertical: 'auto', tabIndex: -1 }));
		this.annotationScroll.contentElement.classList.add('ash-sessions-pdf-annotations');
		this.annotationScroll.append(this.note);
		this.annotations = h(document, 'div');
		this.annotationScroll.append(this.annotations);
		content.append(sidebar);
		this.element.append(controls, content);
		parent.append(this.element);
		super.create(this.element);
		this._register(registerResourceEditorAccessibility(this.element, this.configuration,
			() => this.accessibleContent(), () => localize('sessions.pdfPreview.help', 'The page opens centered and fitted to the reading area. Use the arrow keys, Page Up and Page Down to scroll. Use Scroll mode to choose Continuous scrolling or Page scrolling. New PDFs use the last selected mode. Continuous scrolling places pages in one scrollable document. In Page scrolling, scroll the mouse wheel or press Page Up or Page Down at a page boundary to turn pages. Hold Control or Command and use the mouse wheel to zoom around the pointer. With the page focused, Control or Command plus + or - zooms in or out; Control or Command plus 0 restores 100 percent. Enter a page number and press Enter to navigate, or use Previous page and Next page. Select text and choose Highlight selection. Enter annotation text and choose Add note. Choose Draw and drag on the page; with the page focused, press Space to start a stroke, use arrow keys to draw and press Enter to finish. Choose Erase highlights and drawings, then click a mark or focus its erase button and press Enter. Choose Add text box, then click the page or press Enter with the page focused; enter text and press Control+Enter or Command+Enter to apply. Escape cancels the current tool or text box. Fit page and Fit width switch the page size. Save changes writes annotations into the PDF file. Save a copy lets you choose where to write a PDF with your annotations when the source is read-only. Control+Z or Command+Z undoes an edit; add Shift to redo. Existing annotations have Update and Delete controls.')
				+ '\n\n' + localize('sessions.pdfPreview.thumbnailsHelp', 'PDF page navigation opens the sidebar to the left of the document. Use Left and Right to focus Thumbnails or Outline, then Enter to switch tabs. In Thumbnails, use Up and Down to change pages, or Home and End to go to the first and last page. Outline is blank when the PDF has no bookmarks. Use the arrow keys to browse bookmarks and Enter to open a chapter. Escape closes the sidebar and returns focus to PDF page navigation.')
				+ '\n\n' + localize('sessions.pdfPreview.selectionHelp', 'Selecting text opens the selection toolbar. Press Shift+F10 to focus it, use arrow keys to choose an action, and press Escape to return to the page. Copy copies the selected text. Translate with Ash opens a translation request in the chat draft. Add comment creates a note at the selection and Highlight marks the selected text.')));
		// Workbench dispatches edit commands before bubbling DOM key events.
		for (const [command, operation] of [[UndoCommand, 'undo'], [RedoCommand, 'redo']] as const) {
			this._register(command.addImplementation(120, 'pdf-editor', () => {
				const target = getActiveElement(document);
				if (!this.model || !target || !this.element.contains(target) || ['INPUT', 'TEXTAREA'].includes(target.tagName)) { return false; }
				return this.perform(async () => { await this.model?.[operation](); await this.paint(); });
			}));
		}
		this._register(addDisposableListener(this.element, 'keydown', event => {
			if ((event.ctrlKey || event.metaKey) && ['+', '=', '-', '0'].includes(event.key)) {
				event.preventDefault(); event.stopImmediatePropagation();
				if (!this.busy && !this.stroke && this.displayedPage) {
					if (event.key === '0') { this.setZoom(1); }
					else { this.zoomBy(event.key === '-' ? 1 / 1.2 : 1.2); }
					status(localize('sessions.pdfPreview.zoomLevel', 'PDF zoom: {0}%', Math.round(this.currentScale() * 100)));
				}
				return;
			}
			if (event.key === 'Escape' && !this.textLifetime.value) { this.selectTool(undefined); }
			const target = event.target as HTMLElement;
			if (this.model && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !['INPUT', 'TEXTAREA'].includes(target.tagName)) {
				event.preventDefault(); event.stopPropagation();
				void this.perform(async () => { if (event.shiftKey) { await this.model?.redo(); } else { await this.model?.undo(); } await this.paint(); });
			}
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); void this.perform(() => this.save()); }
		}));
		this._register(toDisposable(() => this.clearInput()));
		this._register(this.configuration.onDidChangeConfiguration(event => {
			if (!event.affectsConfiguration(pdfScrollModeSetting)) { return; }
			if (!this.pendingViewState) { this.savedPage = this.pageNumber; }
			this.pendingViewState = true;
			this.restorePendingViewState();
		}));
		this.viewCreated = true;
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		this.clearInput();
		this.pendingViewState = true;
		this.element.setAttribute('aria-label', localize('sessions.pdfPreview.reader', 'PDF — {0}', input.label ?? basename(input.resource)));
		const store = new DisposableStore();
		this.inputLifetime.value = store;
		const lease = this.editors.acquire(input);
		store.add(lease.release);
		const model = lease.model;
		this.model = model;
		store.add(model.onDidRevert(() => this.navigationPane.resetOutline()));
		store.add(model.onDidChangeContent(() => {
			this.navigationPane.minimap.refresh();
			this.updateControls();
			if (model.recoveryError) { this.showError(model.recoveryError); }
			else if (!this.busy) { void this.showPage(this.pageNumber, this.renderedDimension); }
		}));
		const abort = () => { if (this.inputLifetime.value === store) { this.clearInput(); } };
		signal.addEventListener('abort', abort, { once: true });
		store.add(toDisposable(() => signal.removeEventListener('abort', abort)));
		this.progress.textContent = localize('sessions.pdfPreview.loading', 'Loading PDF…');
		try {
			signal.throwIfAborted();
			await lease.ready;
			if (this.model !== model) { return; }
			await this.showPage(this.savedPage);
			this.restorePendingViewState();
		} catch (error) {
			signal.throwIfAborted();
			if (this.inputLifetime.value === store) {
				this.progress.textContent = '';
				if (!isCancellationError(error)) { this.showError(error); }
			}
		}
	}

	private action(id: string, label: string, icon: Icon, run: () => Promise<unknown> | void, serialize = true): Action {
		const action = this._register(new Action(`sessions.pdfPreview.${id}`, label, '', true, async () => {
			if (serialize) { return this.perform(async () => run()); }
			await run();
		}));
		action.icon = icon;
		action.tooltip = label;
		return action;
	}

	private toolbar(parent: HTMLElement, actions: readonly Action[], label: string): void {
		const toolbar = this._register(new WorkbenchToolBar(parent, this.contextMenus, {
			ariaLabel: label, highlightToggledItems: true, actionViewItemProvider: (action, options) => action === this.scrollModeAction
				? new DropdownMenuActionViewItem(action, () => this.scrollModeActions, { showContextMenu: delegate => this.contextMenus.showContextMenu({ ...delegate, getCheckedActionsRepresentation: () => 'radio' }) }, { ...options, iconOnly: true })
				: new ButtonActionViewItem(action, { ...options, iconOnly: true })
		}));
		toolbar.setActions(actions);
	}

	private createSelectionToolbar(): void {
		const document = this.readingArea.ownerDocument;
		const popup = this.selectionPopup = h(document, 'div', {
			className: 'ash-sessions-pdf-selection-toolbar',
			properties: { hidden: true },
		});
		this.readingArea.append(popup);
		this.selectionLayout = this._register(new AnimationFrameScheduler(getWindow(popup), () => this.layoutSelectionToolbar()));
		const actions = this.selectionActions = this._register(this.instantiation.createInstance(PdfSelectionActions, {
			getSelection: () => {
				const selected = this.selectedText();
				if (!selected) { return; }
				const input = this.inputLifetime.value;
				return {
					text: selected.text,
					isCurrent: () => input === this.inputLifetime.value && !this.isDisposed,
				};
			},
			dismiss: () => this.dismissSelectionToolbar(true),
			addComment: readContents => this.addSelectionNote(readContents),
			highlight: () => this.perform(() => this.highlight()),
			showError: error => this.showError(error),
		} satisfies PdfSelectionActionsHost));
		const toolbar = this._register(new WorkbenchToolBar(popup, this.contextMenus, {
			ariaLabel: localize('sessions.pdfPreview.selectionActions', 'PDF selection actions'),
			actionViewItemProvider: (action, options) => action === actions.copy
				? new CopyActionViewItem(action, { ...options, iconOnly: true }, () => actions.getCopyOperation())
				: new ButtonActionViewItem(action, { ...options, iconOnly: true }),
		}));
		toolbar.setActions(actions.actions);
		// Keep the native selection when a pointer activates a toolbar button.
		this._register(addDisposableListener(popup, 'mousedown', event => event.preventDefault()));
		this._register(addDisposableListener(document, 'pointerdown', event => {
			const target = event.target as Node;
			if (popup.contains(target)) { return; }
			this.selectingText = event.isPrimary && event.button === 0 && this.surface.contains(target);
			this.dismissSelectionToolbar();
		}, true));
		for (const eventType of ['pointerup', 'pointercancel'] as const) {
			this._register(addDisposableListener(document, eventType, event => {
				if (!event.isPrimary || !this.selectingText) { return; }
				this.selectingText = false;
				this.selectionDismissed = false;
				this.selectionLayout.schedule();
			}));
		}
		this._register(addDisposableListener(document, 'selectionchange', () => {
			this.selectionDismissed = false;
			this.selectionLayout.schedule();
		}));
		this._register(addDisposableListener(this.readingArea, 'scroll', () => this.selectionLayout.schedule(), true));
		this._register(addDisposableListener(document, 'focusin', event => {
			if (!popup.hidden && !this.readingArea.contains(event.target as Node)) { this.dismissSelectionToolbar(); }
		}));
		this._register(addDisposableListener(this.readingArea, 'keydown', event => {
			if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
				this.selectionDismissed = false;
				this.layoutSelectionToolbar();
				if (popup.hidden) { return; }
				toolbar.focus();
			} else if (event.key === 'Escape' && !popup.hidden) {
				this.dismissSelectionToolbar(true);
			} else {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
		}));
	}

	private selectedText(): { readonly range: Range; readonly text: string; } | undefined {
		const selection = this.readingArea.ownerDocument.getSelection();
		if (!selection?.rangeCount || selection.isCollapsed) { return; }
		const range = selection.getRangeAt(0);
		const inTextLayer = (node: Node) => {
			const element = isHTMLElement(node) ? node : node.parentElement;
			return this.surface.contains(element) && !!element?.closest('.ash-sessions-pdf-text-content');
		};
		if (!inTextLayer(range.startContainer) || !inTextLayer(range.endContainer)) { return; }
		const text = range.toString();
		if (text.trim()) { return { range, text }; }
	}

	private layoutSelectionToolbar(): void {
		const popup = this.selectionPopup;
		const document = popup.ownerDocument;
		const active = getActiveElement(document);
		if (this.selectionDismissed || this.selectingText || this.busy || this.isNavigating() || this.tool ||
			(active && active !== document.body && !this.readingArea.contains(active))) {
			popup.hidden = true;
			return;
		}
		const selected = this.selectedText();
		if (!selected) {
			popup.hidden = true;
			return;
		}
		const viewport = this.readingArea.getBoundingClientRect();
		const bounds = selected.range.getBoundingClientRect();
		if (!bounds.width || !bounds.height || viewport.width <= 16 || viewport.height <= 16 ||
			bounds.bottom <= viewport.top || bounds.top >= viewport.bottom ||
			bounds.right <= viewport.left || bounds.left >= viewport.right) {
			popup.hidden = true;
			return;
		}
		const editable = this.stage.contains(selected.range.commonAncestorContainer);
		this.selectionActions.setEditable(editable);
		const left = Math.max(bounds.left, viewport.left);
		const top = Math.max(bounds.top, viewport.top);
		popup.hidden = false;
		const position = layout2d(
			{ left: viewport.left + 8, top: viewport.top + 8, width: viewport.width - 16, height: viewport.height - 16 },
			popup.getBoundingClientRect(),
			{ left, top, width: Math.min(bounds.right, viewport.right) - left, height: Math.min(bounds.bottom, viewport.bottom) - top },
			{ anchorAlignment: AnchorAlignment.Center, anchorPosition: AnchorPosition.Above, gap: 8 },
		);
		popup.style.left = `${position.left - viewport.left}px`;
		popup.style.top = `${position.top - viewport.top}px`;
	}

	private dismissSelectionToolbar(restoreFocus = false): void {
		this.selectionDismissed = true;
		if (!this.selectionPopup) { return; }
		const wasFocused = this.selectionPopup.contains(this.selectionPopup.ownerDocument.activeElement);
		this.selectionPopup.hidden = true;
		if (restoreFocus && wasFocused) { this.surface.focus({ preventScroll: true }); }
	}

	private async addSelectionNote(readContents: () => Promise<string | undefined>): Promise<void> {
		const selected = this.selectedText();
		const bounds = selected && this.selectionBounds(selected.range);
		if (!bounds) { return; }
		const input = this.inputLifetime.value;
		const page = this.displayedPage;
		this.dismissSelectionToolbar(true);
		try {
			const contents = await readContents();
			if (input !== this.inputLifetime.value || page !== this.displayedPage || !contents) { return; }
			const size = 0.04;
			const anchor = {
				x: Math.min(bounds.x + bounds.width, 1 - size),
				y: Math.min(bounds.y, 1 - size),
				width: size,
				height: size,
			};
			await this.perform(() => this.edit({ kind: 'note', bounds: anchor, contents }));
		} catch (error) {
			if (input === this.inputLifetime.value && page === this.displayedPage && !this.isDisposed) { this.showError(error); }
		}
	}

	private createPageView(): PdfPageView {
		const view = new PdfPageView(this.element.ownerDocument, {
			pointerDown: event => {
				if (view !== this.activeView) {
					if (this.busy || this.isNavigating() || this.stroke || this.textLifetime.value || !view.page) { return; }
					this.activatePage(view);
				}
				this.handlePointerDown(event);
			},
			pointerMove: event => this.handlePointerMove(event),
			pointerUp: event => { if (event.pointerId === this.pointerId) { void this.perform(() => this.finishStroke()); } },
			pointerCancel: () => this.cancelStroke(),
		});
		return view;
	}

	private async setScrollMode(mode: PdfScrollMode): Promise<void> {
		if (mode === this.scrollMode || !this.displayedPage || this.stroke || this.textLifetime.value) { return; }
		await this.perform(async () => {
			const page = this.displayedPage!;
			const number = this.pageNumber;
			const document = this.element.ownerDocument;
			const hadFocus = this.element.contains(getActiveElement(document));
			this.wheelNavigation = undefined;
			this.scrollMode = mode;
			if (mode === PdfScrollMode.Continuous) {
				const store = new DisposableStore();
				this.continuousLifetime.value = store;
				this.pageScroll.element.hidden = true;
				const continuous = this.continuous = store.add(new PdfContinuousView(this.readingArea, page, {
					createPage: () => this.createPageView(),
					loadPage: (number, signal) => this.model!.render(number, undefined, { dimension: initialRasterDimension, signal }),
					isActive: view => this.activeView === view,
					onDidChangePage: view => {
						if (!this.busy && !this.isNavigating() && !this.stroke && !this.textLifetime.value) { this.activatePage(view); }
					},
					onError: error => this.showError(error),
				}));
				this.surface = continuous.domNode;
				store.add(addDisposableListener(continuous.viewport, 'scroll', () => this.flushWheelZoom()));
				continuous.layout(this.zoom);
				try {
					const view = await continuous.reveal(number);
					if (this.continuous !== continuous) { return; }
					this.activatePage(view);
					this.pagedView.clear();
				} catch (error) {
					if (this.continuous !== continuous) { return; }
					this.continuous = undefined; this.continuousLifetime.clear();
					this.scrollMode = PdfScrollMode.Paged;
					this.surface = this.pageScroll.element; this.surface.hidden = false;
					throw error;
				}
			} else {
				this.pageLifetime.clear(); this.eraseLifetime.clear();
				this.activeView = this.pagedView; this.stage = this.pagedView.domNode;
				this.continuous = undefined; this.continuousLifetime.clear();
				this.surface = this.pageScroll.element; this.surface.hidden = false;
				await this.paint(undefined, number, initialRasterDimension);
				this.pageScroll.scrollTo(0, 0);
			}
			const focused = getActiveElement(document);
			if (hadFocus && (!focused || focused === document.body || this.element.contains(focused))) { this.surface.focus(); }
		});
	}

	private async perform(run: () => Promise<unknown>): Promise<void> {
		if (this.busy || this.isNavigating()) { return; }
		const input = this.inputLifetime.value;
		this.flushWheelZoom();
		this.zoomRefinement.cancel();
		this.pageRender?.controller.abort();
		this.pageTurnDelay.cancel();
		this.busy = true; this.updateControls();
		try { await run(); }
		catch (error) {
			if (input === this.inputLifetime.value && !isCancellationError(error)) { this.showError(error); }
		}
		finally { this.busy = false; this.updateControls(); this.restorePendingViewState(); }
	}

	private isNavigating(): boolean {
		return this.pageRender !== undefined && this.displayedPage?.page !== this.pageNumber;
	}

	private async showPage(number: number, dimension = initialRasterDimension, refinement = false, scrollTarget: 'start' | 'end' | number = 'start'): Promise<void> {
		if (!this.model || (this.busy && this.displayedPage) || !Number.isSafeInteger(number) || number < 1 || number > (this.displayedPage?.pageCount ?? Infinity)) { return; }
		const previous = this.displayedPage?.page ?? 1;
		const replacingTurn = this.isNavigating();
		const replacesPageRequest = this.pageRender && !this.pageRender.refinement && !refinement;
		this.pageRender?.controller.abort();
		const scrollBeforeTurn = this.pageRender?.scrollBeforeTurn ?? this.pageScroll.state;
		const request = { controller: new AbortController(), refinement, scrollBeforeTurn };
		this.pageRender = request;
		const signal = request.controller.signal;
		if (number !== previous) {
			this.zoomRefinement.cancel();
			this.textLifetime.clear(); this.cancelStroke();
		}
		this.pageNumber = number;
		this.pageInput.value = String(number);
		this.updateControls();
		try {
			const continuous = this.continuous;
			const returningToDisplayedPage = !continuous && !refinement && replacingTurn && number === this.displayedPage?.page;
			if (!continuous && !refinement) {
				// Draw while the virtual row still owns its decoded image, even if a previous raster is pending.
				const thumbnail = number !== previous ? this.navigationPane.minimap.getThumbnail(number) : undefined;
				if (thumbnail) {
					this.pagedView.showThumbnail(thumbnail);
					this.updateZoom();
					this.pageScroll.scrollTo(0, scrollTarget === 'end' ? this.pageScroll.state.maximumTop : 0);
				} else if (replacingTurn) {
					this.pagedView.clearThumbnail();
					this.updateZoom();
					this.pageScroll.scrollTo(scrollBeforeTurn.left, scrollBeforeTurn.top);
				}
			}
			// Keep coalescing repeated input. Continuous navigation can take over the
			// viewport's existing renders, so it needs a shorter settling interval.
			if (replacesPageRequest) {
				await this.pageTurnDelay.trigger(() => undefined, continuous ? 40 : undefined);
			}
			// Only the latest request may start once the previous render has released its buffer.
			await this.pagePaint;
			if (signal.aborted) { return; }
			const outlineTop = typeof scrollTarget === 'number' ? scrollTarget : undefined;
			let paint: Promise<void> | undefined;
			if (continuous && !refinement && (number !== previous || replacesPageRequest || outlineTop !== undefined)) {
				const thumbnail = this.navigationPane.minimap.getThumbnail(number);
				paint = continuous.reveal(number, outlineTop, thumbnail, signal).then(view => {
					if (!signal.aborted) { this.activatePage(view); }
				});
			} else if (!returningToDisplayedPage) {
				paint = this.paint(undefined, number, dimension, signal);
			}
			if (paint) {
				this.pagePaint = paint.catch(() => undefined);
				await paint;
			}
			if (signal.aborted) { return; }
			if (!this.continuous) {
				if (outlineTop !== undefined) {
					const pageBounds = this.stage.getBoundingClientRect();
					const viewport = this.pageScroll.scrollableElement.getBoundingClientRect();
					const pageTop = this.pageScroll.state.top + pageBounds.top - viewport.top;
					this.pageScroll.scrollTo(0, pageTop + pageBounds.height * outlineTop);
				} else if (number !== previous) {
					this.pageScroll.scrollTo(0, scrollTarget === 'end' ? this.pageScroll.state.maximumTop : 0);
				}
			}
			if (!refinement && typeof this.zoom === 'number') { this.zoomRefinement.schedule(); }
		} catch (error) {
			if (signal.aborted) { return; }
			this.pageNumber = previous;
			this.pageInput.value = String(previous);
			if (!this.continuous) {
				this.pagedView.clearThumbnail();
				this.updateZoom();
				this.pageScroll.scrollTo(scrollBeforeTurn.left, scrollBeforeTurn.top);
			}
			if (!this.displayedPage) { this.progress.textContent = ''; }
			if (!isCancellationError(error)) { this.showError(error); }
		} finally {
			if (this.pageRender === request) {
				this.pageRender = undefined;
				this.pagePaint = undefined;
				this.updateControls();
				this.restorePendingViewState();
			}
		}
	}

	private async edit(edit: PdfAnnotationEdit): Promise<void> {
		if (!this.model) { return; }
		await this.paint(edit);
	}

	private async highlight(contents?: string): Promise<void> {
		const selection = this.element.ownerDocument.getSelection();
		if (!selection?.rangeCount || !selection.toString().trim()) {
			throw new Error(localize('sessions.pdfPreview.selectText', 'Select text on the page first.'));
		}
		const bounds = this.selectionBounds(selection.getRangeAt(0));
		if (!bounds) { return; }
		const text = contents || selection.toString().slice(0, 8192);
		this.dismissSelectionToolbar(true);
		await this.edit({ kind: 'highlight', bounds, contents: text });
	}

	private selectionBounds(range: Range): PdfRect | undefined {
		if (!this.stage.contains(range.commonAncestorContainer)) { return; }
		const page = this.stage.getBoundingClientRect();
		const bounds = range.getBoundingClientRect();
		// Selection geometry is normalized before crossing the native boundary.
		const left = Math.max(page.left, bounds.left);
		const top = Math.max(page.top, bounds.top);
		const right = Math.min(page.right, bounds.right);
		const bottom = Math.min(page.bottom, bounds.bottom);
		if (left >= right || top >= bottom) { return; }
		return { x: (left - page.left) / page.width, y: (top - page.top) / page.height, width: (right - left) / page.width, height: (bottom - top) / page.height };
	}

	private async paint(edit?: PdfAnnotationEdit, number = this.pageNumber, dimension = this.renderedDimension, signal?: AbortSignal): Promise<void> {
		const model = this.model;
		if (!model) { return; }
		const input = this.inputLifetime.value;
		const view = this.activeView;
		const { page, bytes } = await model.render(number, edit, { dimension, signal });
		if (signal?.aborted || this.inputLifetime.value !== input || view !== this.activeView) { return; }
		await view.render(page, bytes, dimension, signal);
		if (signal?.aborted || this.inputLifetime.value !== input) { return; }
		this.renderedDimension = view.dimension;
		this.activatePage(view);
		if (!this.pageRender?.refinement && this.continuous) { this.continuous.invalidateOtherPages(view); }
	}

	private activatePage(view: PdfPageView): void {
		const page = view.page;
		if (!page || (this.activeView === view && this.displayedPage === page)) { return; }
		if (this.displayedPage?.page !== page.page) {
			this.zoomRefinement.cancel();
			if (this.pageRender?.refinement) { this.pageRender.controller.abort(); }
		}
		this.textLifetime.clear(); this.cancelStroke();
		const store = new DisposableStore();
		this.pageLifetime.value = store;
		this.activeView = view;
		this.stage = view.domNode;
		this.displayedPage = page;
		this.renderedDimension = view.dimension;
		this.pageNumber = page.page;
		this.pageInput.value = String(page.page);
		store.add(view.onDidChangeText(() => this.updateControls()));
		this.renderEraseTargets();
		const document = this.element.ownerDocument;
		const annotations = page.annotations.filter(isReviewAnnotation);
		this.annotations.replaceChildren();
		for (const annotation of annotations) {
			const item = h(document, 'div', { className: 'ash-sessions-pdf-annotation' });
			item.append(h(document, 'p', { properties: { textContent: `${annotation.kind}${annotation.author ? ` · ${annotation.author}` : ''}` } }));
			const contents = h(document, 'textarea', { properties: { value: annotation.contents, maxLength: 8192, rows: 2 }, attributes: { 'aria-label': localize('sessions.pdfPreview.noteText', 'Annotation text') } });
			item.append(contents);
			for (const [label, edit] of [
				[localize('sessions.pdfPreview.updateAnnotation', 'Update'), () => ({ kind: 'update' as const, index: annotation.index, contents: contents.value })],
				[localize('sessions.pdfPreview.deleteAnnotation', 'Delete'), () => ({ kind: 'delete' as const, index: annotation.index })],
			] as const) {
				store.add(new Button(item, { ...defaultButtonStyles, label, onClick: () => { void this.perform(() => this.edit(edit())); } }));
			}
			this.annotations.append(item);
		}
		this.pageInput.style.width = `${Math.max(2, String(page.pageCount).length)}ch`;
		this.pageCount.textContent = `/${page.pageCount}`;
		const progress = localize('sessions.pdfPreview.page', 'Page {0} of {1}', page.page, page.pageCount);
		if (this.progress.textContent !== progress) { this.progress.textContent = progress; }
		this.updateAnnotationPanel(true);
		if (this.continuous) { this.updateFitAction(); }
		else { this.updateZoom(); }
		this.updateControls();
	}

	private selectTool(tool: PdfTool | undefined): void {
		this.cancelStroke();
		this.textLifetime.clear();
		this.tool = tool === this.tool ? undefined : tool;
		if (!this.stage) { return; }
		this.inkAction.checked = this.tool === 'ink';
		this.eraserAction.checked = this.tool === 'eraser';
		this.textAction.checked = this.tool === 'text';
		this.stage.classList.toggle('drawing', this.tool === 'ink');
		this.stage.classList.toggle('erasing', this.tool === 'eraser');
		this.stage.classList.toggle('adding-text', this.tool === 'text');
		if (this.tool) { this.dismissSelectionToolbar(); }
		this.renderEraseTargets();
		if (this.tool) { this.surface.focus(); }
	}

	private pagePoint(event: PointerEvent): PdfPoint {
		const rect = this.stage.getBoundingClientRect();
		return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
	}

	private handlePointerDown(event: PointerEvent): void {
		if (event.button !== 0 || !event.isPrimary || this.busy || this.isNavigating() || !this.displayedPage || this.textLifetime.value) { return; }
		if (this.tool === 'text') {
			event.preventDefault();
			this.openTextBox(this.pagePoint(event));
		} else if (this.tool === 'ink') {
			event.preventDefault();
			this.surface.focus();
			this.startStroke(this.pagePoint(event));
			this.pointerId = event.pointerId;
			this.stage.setPointerCapture(event.pointerId);
		}
	}

	private handlePointerMove(event: PointerEvent): void {
		if (event.pointerId !== this.pointerId || !this.stroke) { return; }
		this.extendStroke(this.pagePoint(event));
	}

	private startStroke(point: PdfPoint): void {
		this.cancelStroke();
		this.stroke = [point];
		const svg = this.element.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.classList.add('ash-sessions-pdf-stroke');
		svg.setAttribute('viewBox', '0 0 1 1');
		svg.setAttribute('preserveAspectRatio', 'none');
		svg.setAttribute('aria-hidden', 'true');
		this.strokePreview = this.element.ownerDocument.createElementNS(svg.namespaceURI, 'polyline') as SVGPolylineElement;
		this.strokePreview.setAttribute('vector-effect', 'non-scaling-stroke');
		svg.append(this.strokePreview);
		this.stage.append(svg);
	}

	private extendStroke(point: PdfPoint): void {
		if (!this.stroke) { return; }
		// Bound one stroke to the native operation budget, retaining the final pointer position.
		if (this.stroke.length === 1024) { this.stroke[this.stroke.length - 1] = point; }
		else { this.stroke.push(point); }
		this.strokePreview?.setAttribute('points', this.stroke.map(point => `${point.x.toFixed(5)},${point.y.toFixed(5)}`).join(' '));
	}

	private async finishStroke(): Promise<void> {
		const points = this.stroke;
		this.cancelStroke();
		if (points && points.length > 1) { await this.edit({ kind: 'ink', points }); }
	}

	private cancelStroke(): void {
		if (this.pointerId !== undefined && this.stage.hasPointerCapture(this.pointerId)) { this.stage.releasePointerCapture(this.pointerId); }
		this.pointerId = undefined;
		this.stroke = undefined;
		this.strokePreview?.parentElement?.remove();
		this.strokePreview = undefined;
	}

	private turnPageAtBoundary(direction: number): boolean {
		const page = this.displayedPage;
		if (!page || this.busy || this.isNavigating() || this.stroke || this.textLifetime.value || this.continuous) { return false; }
		const { top, maximumTop } = this.pageScroll.state;
		if (direction > 0 ? top < maximumTop - 1 : top > 1) { return false; }
		const number = this.pageNumber + direction;
		if (number < 1 || number > page.pageCount) { return false; }
		void this.showPage(number, initialRasterDimension, false, direction < 0 ? 'end' : 'start');
		return true;
	}

	private handlePageWheel(event: WheelEvent): void {
		if (this.continuous) { return; }
		const target = event.target as HTMLElement;
		if (event.shiftKey || event.altKey || target.closest('input, textarea, [contenteditable="true"]')) { return; }
		const wheel = new StandardWheelEvent(event, { pageWidth: this.pageScroll.state.width, pageHeight: this.pageScroll.state.height });
		if (Math.abs(wheel.deltaY) <= Math.abs(wheel.deltaX)) { return; }
		const direction = Math.sign(wheel.deltaY);
		let gesture = this.wheelNavigation;
		if (!gesture || event.timeStamp - gesture.time > 200 || gesture.direction !== direction) {
			gesture = this.wheelNavigation = { time: event.timeStamp, direction, distance: 0, turned: false };
		}
		gesture.time = event.timeStamp;
		// A trackpad's momentum must not turn another page after the raster arrives.
		if (gesture.turned) { wheel.stop(); return; }
		const { top, maximumTop } = this.pageScroll.state;
		if (direction > 0 ? top < maximumTop - 1 : top > 1) {
			gesture.distance = 0;
			return;
		}
		gesture.distance += Math.abs(wheel.deltaY);
		if (gesture.distance >= 60 && this.turnPageAtBoundary(direction)) {
			gesture.turned = true;
			wheel.stop();
		}
	}

	private handlePageKeydown(event: KeyboardEvent): void {
		if (event.target !== this.surface || this.busy || this.isNavigating()) { return; }
		if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && ['PageUp', 'PageDown'].includes(event.key)
			&& this.turnPageAtBoundary(event.key === 'PageDown' ? 1 : -1)) {
			event.preventDefault(); event.stopImmediatePropagation();
			return;
		}
		if (this.tool === 'text' && event.key === 'Enter') {
			event.preventDefault(); event.stopImmediatePropagation();
			this.openTextBox(this.keyboardPoint);
		} else if (this.tool === 'ink') {
			if (event.key === ' ' || event.key === 'Enter') {
				event.preventDefault(); event.stopImmediatePropagation();
				if (this.stroke) { void this.perform(() => this.finishStroke()); }
				else { this.startStroke(this.keyboardPoint); }
			} else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
				event.preventDefault(); event.stopImmediatePropagation();
				const step = event.shiftKey ? 0.05 : 0.01;
				this.keyboardPoint = {
					x: Math.max(0, Math.min(1, this.keyboardPoint.x + (event.key === 'ArrowRight' ? step : 0) - (event.key === 'ArrowLeft' ? step : 0))),
					y: Math.max(0, Math.min(1, this.keyboardPoint.y + (event.key === 'ArrowDown' ? step : 0) - (event.key === 'ArrowUp' ? step : 0))),
				};
				this.extendStroke(this.keyboardPoint);
			}
		}
	}

	private renderEraseTargets(): void {
		this.eraseLifetime.clear();
		if (this.tool !== 'eraser') { return; }
		const store = new DisposableStore();
		this.eraseLifetime.value = store;
		for (const annotation of this.displayedPage?.annotations ?? []) {
			if (annotation.kind !== 'Highlight' && annotation.kind !== 'Ink') { continue; }
			const label = annotation.kind === 'Ink' ? localize('sessions.pdfPreview.eraseDrawing', 'Erase drawing') : localize('sessions.pdfPreview.eraseHighlight', 'Erase highlight');
			const target = h(this.element.ownerDocument, 'button', { className: 'ash-sessions-pdf-erase-target', properties: { type: 'button' }, attributes: { 'aria-label': label } });
			this.position(target, annotation.bounds);
			store.add(addDisposableListener(target, 'click', () => { void this.perform(() => this.edit({ kind: 'delete', index: annotation.index })); }));
			this.stage.append(target);
			store.add(toDisposable(() => target.remove()));
		}
	}

	private openTextBox(point: PdfPoint): void {
		this.textLifetime.clear();
		const store = new DisposableStore();
		this.textLifetime.value = store;
		const document = this.element.ownerDocument;
		const bounds = { x: Math.min(point.x, 0.65), y: Math.min(point.y, 0.84), width: 0.35, height: 0.16 };
		const editor = h(document, 'div', { className: 'ash-sessions-pdf-text-editor' });
		this.position(editor, bounds);
		const input = h(document, 'textarea', { properties: { maxLength: 8192, rows: 3 }, attributes: { 'aria-label': localize('sessions.pdfPreview.textBox', 'Text box') } });
		const actions = h(document, 'div', { className: 'ash-sessions-pdf-text-actions' });
		const cancel = () => { this.textLifetime.clear(); this.surface.focus(); };
		const apply = async () => {
			if (!input.value.trim()) { cancel(); return; }
			await this.edit({ kind: 'text', bounds, contents: input.value });
			cancel();
		};
		store.add(new Button(actions, { ...defaultButtonStyles, label: localize('sessions.pdfPreview.applyText', 'Apply text'), icon: Lxicon.check, iconOnly: true, onClick: () => { void this.perform(apply); } }));
		store.add(new Button(actions, { ...defaultButtonStyles, label: localize('sessions.pdfPreview.cancelText', 'Cancel text'), icon: Lxicon.close, iconOnly: true, onClick: cancel }));
		store.add(addDisposableListener(editor, 'keydown', event => {
			if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
			if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); void this.perform(apply); }
		}));
		editor.append(input, actions);
		this.stage.append(editor);
		store.add(toDisposable(() => editor.remove()));
		input.focus();
	}

	private position(element: HTMLElement, bounds: PdfRect): void {
		element.style.left = `${bounds.x * 100}%`; element.style.top = `${bounds.y * 100}%`;
		element.style.width = `${bounds.width * 100}%`; element.style.height = `${bounds.height * 100}%`;
	}

	private updateAnnotationPanel(visible: boolean): void {
		this.annotationPanel.hidden = !visible;
		this.element.classList.toggle('has-annotation-panel', visible);
		this.annotationScroll.layout();
	}

	private setNavigationPaneVisible(visible: boolean): void {
		this.navigationPane.setVisible(visible);
		this.navigationToggle.toggleClassName('checked', visible);
		this.navigationToggle.domNode.setAttribute('aria-expanded', String(visible));
		const page = this.displayedPage;
		if (visible && page) { this.navigationPane.setPage(page.page, page.pageCount); }
	}

	private currentScale(clientY?: number): number {
		if (this.continuous) { return this.continuous.scaleAt(clientY); }
		const page = this.displayedPage;
		return page ? this.stage.getBoundingClientRect().width / (page.widthPoints * 96 / 72) : 1;
	}

	private zoomBy(factor: number): void {
		this.flushWheelZoom();
		const current = this.currentScale();
		if (current <= 0) { return; }
		const scale = clamp(current * factor, 0.1, 8);
		// A fitted page can lie outside the manual range. Keep gesture direction consistent at that boundary.
		if (factor > 1 ? scale <= current : scale >= current) { return; }
		this.setZoom(scale);
	}

	private zoomAnchors(): { readonly x: ZoomAnchor; readonly y: ZoomAnchor; } {
		const viewport = this.pageScroll.scrollableElement;
		const style = getWindow(viewport).getComputedStyle(this.pageScroll.contentElement);
		const size = this.stage.getBoundingClientRect();
		return {
			x: new ZoomAnchor({ viewport: viewport.clientWidth, scroll: viewport.scrollLeft, size: size.width, insetStart: parseFloat(style.paddingLeft), insetEnd: parseFloat(style.paddingRight) }),
			y: new ZoomAnchor({ viewport: viewport.clientHeight, scroll: viewport.scrollTop, size: size.height, insetStart: parseFloat(style.paddingTop), insetEnd: parseFloat(style.paddingBottom) }),
		};
	}

	private queueWheelZoom(wheel: StandardWheelEvent): void {
		const page = this.displayedPage;
		if (!page) { return; }
		const current = this.continuousWheelZoom?.scale ?? this.wheelZoom?.scale ?? this.currentScale(wheel.browserEvent.clientY);
		if (current <= 0) { return; }
		const delta = clamp(wheel.deltaY, -240, 240);
		const scale = clamp(current * Math.exp(-delta * 0.002), 0.1, 8);
		if (delta < 0 ? scale <= current : scale >= current) { return; }
		if (this.continuous) {
			this.continuousWheelZoom = { scale, x: wheel.browserEvent.clientX, y: wheel.browserEvent.clientY };
			this.wheelZoomFrame.schedule();
			this.queueZoomRefinement();
			return;
		}
		const zoom = this.wheelZoom ??= { scale: current, ...this.zoomAnchors() };
		const viewport = this.pageScroll.scrollableElement.getBoundingClientRect();
		const width = page.widthPoints * 96 / 72 * scale;
		zoom.x.zoomAround(wheel.browserEvent.clientX - viewport.left, width);
		zoom.y.zoomAround(wheel.browserEvent.clientY - viewport.top, width * page.height / page.width);
		zoom.scale = scale;
		this.wheelZoomFrame.schedule();
		this.queueZoomRefinement();
	}

	private flushWheelZoom(): void {
		const continuousZoom = this.continuousWheelZoom;
		if (continuousZoom && this.continuous) {
			this.cancelWheelZoom();
			this.zoom = continuousZoom.scale;
			this.continuous.layout(this.zoom, continuousZoom);
			this.updateFitAction();
			return;
		}
		const zoom = this.wheelZoom;
		if (!zoom) { return; }
		this.cancelWheelZoom();
		const viewport = this.pageScroll.scrollableElement;
		const left = zoom.x.scrollPosition + viewport.scrollLeft - zoom.x.scroll;
		const top = zoom.y.scrollPosition + viewport.scrollTop - zoom.y.scroll;
		this.zoom = zoom.scale;
		this.updateZoom();
		this.pageScroll.scrollTo(left, top);
	}

	private cancelWheelZoom(): void {
		this.wheelZoomFrame?.cancel();
		this.wheelZoom = undefined;
		this.continuousWheelZoom = undefined;
	}

	private setZoom(zoom: PdfZoom): void {
		this.cancelWheelZoom();
		const page = this.displayedPage;
		if (!page || this.busy || this.stroke || this.currentScale() <= 0) { return; }
		if (this.continuous) {
			const viewport = this.continuous.viewport.getBoundingClientRect();
			this.zoom = zoom;
			this.continuous.layout(zoom, { x: viewport.left + viewport.width / 2, y: viewport.top + viewport.height / 2 });
			this.queueZoomRefinement();
			this.updateFitAction();
			return;
		}
		const anchor = this.zoomAnchors();
		this.zoom = zoom;
		this.updateZoom();
		this.queueZoomRefinement();
		if (typeof zoom !== 'number') { this.pageScroll.scrollTo(0, 0); return; }
		const width = page.widthPoints * 96 / 72 * zoom;
		anchor.x.zoomAround(anchor.x.viewport / 2, width);
		anchor.y.zoomAround(anchor.y.viewport / 2, width * page.height / page.width);
		this.pageScroll.scrollTo(anchor.x.scrollPosition, anchor.y.scrollPosition);
	}

	private queueZoomRefinement(): void {
		if (this.pageRender?.refinement) {
			this.pageRender.controller.abort();
		}
		this.zoomRefinement.schedule();
	}

	private refineZoom(): void {
		if (!this.displayedPage || this.busy || this.stroke || this.isNavigating()) { return; }
		this.flushWheelZoom();
		const size = this.stage.getBoundingClientRect();
		const physicalEdge = Math.max(size.width, size.height) * getWindow(this.stage).devicePixelRatio;
		const dimension = Math.min(maximumRasterDimension, Math.ceil(physicalEdge / 256) * 256);
		if (dimension > this.renderedDimension) { void this.showPage(this.pageNumber, dimension, true); }
	}

	private updateZoom(): void {
		if (!this.pageScroll || !this.fitAction) { return; }
		const page = this.activeView?.geometry;
		if (!page) { return; }
		if (this.continuous) { this.continuous.layout(this.zoom); this.updateFitAction(); return; }
		const viewport = this.pageScroll.scrollableElement;
		const style = viewport.ownerDocument.defaultView!.getComputedStyle(this.pageScroll.contentElement);
		const width = Math.max(1, viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
		const height = Math.max(1, viewport.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom));
		let pageWidth = width;
		if (typeof this.zoom === 'number') { pageWidth = page.widthPoints * 96 / 72 * this.zoom; }
		else if (this.zoom === 'page') { pageWidth = Math.min(width, height * page.widthPoints / page.heightPoints); }
		this.activeView.setSize(pageWidth, pageWidth * page.heightPoints / page.widthPoints);
		this.pageScroll.layout();
		this.updateFitAction();
	}

	private updateFitAction(): void {
		this.selectionLayout?.schedule();
		this.fitAction.label = this.fitAction.tooltip = this.zoom === 'page' ? localize('sessions.pdfPreview.fitWidth', 'Fit width') : localize('sessions.pdfPreview.fitPage', 'Fit page');
		this.fitAction.icon = this.zoom === 'page' ? Lxicon.screenFull : Lxicon.screenNormal;
	}

	private updateControls(): void {
		if (!this.previous) { return; }
		const page = this.displayedPage;
		const navigating = this.isNavigating();
		this.navigationToggle.enabled = !!page;
		this.navigationPane.minimap.setPaused(this.busy || !!this.pageRender);
		if (page && !navigating) { this.navigationPane.setPage(page.page, page.pageCount); }
		this.previous.enabled = !this.busy && !!page && this.pageNumber > 1;
		this.next.enabled = !this.busy && !!page && this.pageNumber < page.pageCount;
		this.saveAction.label = this.saveAction.tooltip = this.model?.savesCopy
			? localize('sessions.pdfPreview.saveCopy', 'Save a copy') : localize('sessions.pdfPreview.save', 'Save changes');
		this.saveAction.enabled = !this.busy && !navigating && !!this.model?.isDirty;
		this.highlightAction.enabled = !this.busy && !navigating && this.activeView.hasText;
		for (const action of [this.noteAction, this.inkAction, this.eraserAction, this.textAction]) {
			action.enabled = !this.busy && !navigating && !!page;
		}
		this.fitAction.enabled = !!page;
		this.scrollModeAction.enabled = !this.busy && !navigating && !!page;
		this.scrollModeAction.icon = this.scrollMode === PdfScrollMode.Continuous ? Lxicon.files : Lxicon.file;
		for (const action of this.scrollModeActions) { action.checked = action.id === `sessions.pdfPreview.${this.scrollMode}`; }
		this.pageInput.disabled = this.busy || !page;
		this.note.disabled = this.busy || !page;
		this.element.setAttribute('aria-busy', String(this.busy || navigating));
		this.selectionLayout?.schedule();
	}

	private showError(error: unknown): void {
		if (this.isDisposed) { return; }
		this.notifications.error(localize('sessions.pdfPreview.operationFailed', 'Could not complete the PDF operation: {0}', error instanceof Error ? error.message : String(error)));
	}

	private accessibleContent(): string {
		const page = this.displayedPage;
		if (!page) { return this.progress.textContent ?? ''; }
		return [this.progress.textContent, page.text || localize('sessions.pdfPreview.noText', 'This page has no extractable text.'),
		...page.annotations.filter(isReviewAnnotation).map(annotation => `${annotation.kind}: ${annotation.contents}`),
		page.textTruncated || page.annotationsTruncated ? localize('sessions.pdfPreview.truncated', 'Some page content exceeds the reading limit.') : ''].filter(Boolean).join('\n\n');
	}

	public override async save(): Promise<void> { await this.model?.save(new AbortController().signal); }
	public override reportSaveError(error: unknown): void { this.showError(error); }
	public override clearInput(): void {
		// The pane host also clears the input when create() fails before the controls exist.
		if (!this.viewCreated) { return; }
		if (this.navigationPane?.domNode.hidden === false) { this.setNavigationPaneVisible(false); }
		this.navigationPane?.resetOutline();
		this.dismissSelectionToolbar();
		this.selectingText = false;
		this.cancelWheelZoom();
		this.wheelNavigation = undefined;
		this.zoomRefinement.cancel();
		this.pageRender?.controller.abort();
		this.pageTurnDelay.cancel();
		this.pageRender = undefined;
		this.pagePaint = undefined;
		this.displayedPage = undefined;
		this.renderedDimension = initialRasterDimension;
		this.textLifetime.clear(); this.cancelStroke(); this.selectTool(undefined);
		this.continuous = undefined; this.continuousLifetime.clear(); this.activeView = this.pagedView; this.stage = this.pagedView?.domNode; this.scrollMode = PdfScrollMode.Paged;
		if (this.pageScroll) { this.surface = this.pageScroll.element; this.surface.hidden = false; }
		this.pageLifetime.clear(); this.inputLifetime.clear(); this.model = undefined; this.pageNumber = 1;
		this.pagedView?.clear(); this.annotations?.replaceChildren();
		this.pageScroll?.scrollTo(0, 0);
		this.progress.textContent = '';
		this.pageInput.value = '1';
		this.pageCount.textContent = '/–';
		this.note.value = '';
		this.updateAnnotationPanel(false);
		this.updateControls();
	}
	public override focus(): void { this.surface.focus(); }
	public override layout(dimension: IDimension): void {
		this.flushWheelZoom();
		this.element.classList.toggle('narrow', dimension.width < 640);
		this.updateZoom();
		this.annotationScroll.layout();
		this.restorePendingViewState();
	}
	public saveViewState(): unknown { return { page: this.pageNumber }; }
	public restoreViewState(state: unknown): void {
		// Older states included a per-file mode. The profile now owns that preference.
		if (state && typeof state === 'object' && 'page' in state) { state = state.page; }
		if (typeof state === 'number' && Number.isSafeInteger(state) && state > 0) {
			const number = state;
			this.savedPage = number;
			this.pendingViewState = true;
			this.restorePendingViewState();
		}
	}

	private restorePendingViewState(): void {
		// Startup restores inactive panes before their page and viewport are ready.
		if (!this.pendingViewState || !this.displayedPage || this.busy || this.isNavigating()
			|| this.readingArea.clientWidth === 0 || this.readingArea.clientHeight === 0) { return; }
		this.pendingViewState = false;
		const model = this.model;
		const number = this.savedPage;
		const mode = this.configuration.getValue<PdfScrollMode>(pdfScrollModeSetting);
		void this.setScrollMode(mode).then(() => {
			if (this.model === model && this.savedPage === number && this.configuration.getValue<PdfScrollMode>(pdfScrollModeSetting) === mode && number !== this.pageNumber) { return this.showPage(number); }
		});
	}

}
