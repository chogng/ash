import type { VSBuffer } from '../../../../base/common/buffer.js';
import type { IBrowserViewFindInPageOptions, IBrowserElementSelectionOptions, IBrowserElementCommentsUpdate, IBrowserViewCaptureScreenshotOptions } from '../../../../platform/browserView/common/browserView.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { IBrowserViewService, type BrowserViewEvent, type IBrowserViewBounds, type IBrowserViewCreateOptions, type IBrowserViewInfo, type IBrowserViewOwner, type IBrowserViewState } from '../../../../platform/browserView/common/browserView.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrowserEditorInput, IBrowserEditorInputData } from './browserEditorInput.js';
import type { IntegratedBrowserOpenSource } from '../../../../platform/browserView/common/browserViewTelemetry.js';
import type { EditorOpenOptions } from '../../../services/editor/common/editorService.js';

export const BrowserViewEditorId = 'workbench.editor.browser';

export const IBrowserViewWorkbenchService = createServiceIdentifier<IBrowserViewWorkbenchService>('browserViewWorkbenchService');

export interface IBrowserViewFilterContext {
	readonly sandboxSessionId?: string;
	readonly activeSessionId?: string;
}

/** Presentation filters do not grant access to a page; Main still enforces agent authority. */
export interface IBrowserViewContextualFilter {
	include(input: BrowserEditorInput, context: IBrowserViewFilterContext): boolean;
	readonly onDidChange?: Event<void>;
}

export interface IBrowserViewOpenHandler {
	shouldOpenEditor(input: BrowserEditorInput, owner: IBrowserViewOwner, editorOptions: EditorOpenOptions): boolean;
}

export interface IBrowserViewWorkbenchCreateOptions extends Omit<IBrowserViewCreateOptions, 'session'> {
	readonly session?: IBrowserViewCreateOptions['session'];
}

export interface IBrowserViewPresentationOptions {
	/** Product pages can present the website without browser navigation and page toolbars. */
	readonly showControls?: boolean;
}

export interface IBrowserViewWorkbenchService {
	readonly onDidChangeBrowserViews: Event<void>;
	initialize(): Promise<void>;
	getKnownBrowserViews(): ReadonlyMap<string, BrowserEditorInput>;
	getContextualBrowserViews(context?: IBrowserViewFilterContext): Map<string, BrowserEditorInput>;
	registerContextualFilter(filter: IBrowserViewContextualFilter): IDisposable;
	registerOpenHandler(handler: IBrowserViewOpenHandler): IDisposable;
	/**
	 * Reserve a page for a window contribution before discovery or creation. The contribution
	 * owns its presentation: it is excluded from contextual tabs and automatic editor restoration,
	 * and closing an editor or archiving a Session does not destroy it. This does not change
	 * Main's page owner, storage or access grants. Disposal releases the reservation only.
	 */
	registerWindowBrowserView(id: string, presentation?: IBrowserViewPresentationOptions): IDisposable;
	isWindowBrowserView(id: string): boolean;
	getBrowserViewPresentation(id: string): IBrowserViewPresentationOptions | undefined;
	getOrCreateLazy(data: IBrowserEditorInputData): BrowserEditorInput;
	createBrowserView(options: IBrowserViewWorkbenchCreateOptions, source?: IntegratedBrowserOpenSource): Promise<BrowserEditorInput>;
}

export interface IBrowserViewModel extends IDisposable {
	getConsoleLogs(): Promise<string>;
	getSelectedText(): Promise<string>;
	findInPage(text: string, options?: IBrowserViewFindInPageOptions): Promise<void>;
	stopFindInPage(keepSelection?: boolean): Promise<void>;
	toggleElementSelection(enabled?: boolean, options?: IBrowserElementSelectionOptions): Promise<void>;
	setElementComments(update: IBrowserElementCommentsUpdate): Promise<void>;
	toggleAreaSelection(enabled?: boolean): Promise<void>;
	captureScreenshot(options?: IBrowserViewCaptureScreenshotOptions): Promise<VSBuffer>;

	readonly id: string;
	readonly state: IBrowserViewState;
	readonly info: IBrowserViewInfo;
	readonly onDidChangeState: Event<IBrowserViewState>;
	readonly onDidClose: Event<void>;
	readonly onWillDispose: Event<void>;
	readonly onDidEvent: Event<BrowserViewEvent>;
	loadURL(url: string): Promise<void>;
	goBack(): Promise<void>;
	goForward(): Promise<void>;
	reload(hard?: boolean): Promise<void>;
	stop(): Promise<void>;
	focus(): Promise<void>;
	layout(bounds: IBrowserViewBounds): Promise<void>;
	setVisible(visible: boolean): Promise<void>;
	getSharing(): Promise<readonly string[]>;
	setSharing(threadIds: readonly string[]): Promise<void>;
}

/** A renderer read model. Only Main computes page state; commands return to the same page owner. */
export class BrowserViewModel extends Disposable implements IBrowserViewModel {
	private readonly disposing = this._register(new Emitter<void>());
	public readonly onWillDispose = this.disposing.event;
	private readonly stateChanges = this._register(new Emitter<IBrowserViewState>());
	public readonly onDidChangeState = this.stateChanges.event;
	private readonly closed = this._register(new Emitter<void>());
	public readonly onDidClose = this.closed.event;
	private readonly events = this._register(new Emitter<BrowserViewEvent>());
	public readonly onDidEvent = this.events.event;
	private currentState: IBrowserViewState;
	private stateRevision = 0;
	private isClosed = false;

	constructor(private readonly initialInfo: IBrowserViewInfo, @IBrowserViewService private readonly service: IBrowserViewService) {
		super();
		this.currentState = initialInfo.state;
		this._register(service.onDidEvent(event => {
			const id = event.type === 'created' ? event.info.id : event.type === 'stateChanged' ? event.state.targetId : event.targetId;
			if (id !== this.id || this.isClosed) { return; }
			if (event.type === 'stateChanged' && event.state.targetId === this.id) {
				this.stateRevision++;
				this.currentState = event.state;
				this.stateChanges.fire(event.state);
			} else if (event.type === 'closed' && event.targetId === this.id) {
				this.isClosed = true;
				this.closed.fire();
			}
			this.events.fire(event);
		}));
	}

	public get id(): string { return this.initialInfo.id; }
	public get state(): IBrowserViewState { return this.currentState; }
	public get info(): IBrowserViewInfo { return { ...this.initialInfo, state: this.currentState }; }

	public async initialize(): Promise<void> {
		// A later event must win over an earlier snapshot whose IPC response arrives after it.
		const revision = this.stateRevision;
		const state = await this.service.getState(this.id);
		this.assertNotDisposed();
		if (this.isClosed) { throw new Error('BrowserTargetUnavailable'); }
		if (revision === this.stateRevision) {
			this.currentState = state;
			this.stateChanges.fire(state);
		}
	}

	public getConsoleLogs(): Promise<string> { return this.service.getConsoleLogs(this.id); }
	public getSelectedText(): Promise<string> { return this.service.getSelectedText(this.id); }
	public findInPage(text: string, options?: IBrowserViewFindInPageOptions): Promise<void> { return this.service.findInPage(this.id, text, options); }
	public stopFindInPage(keepSelection?: boolean): Promise<void> { return this.service.stopFindInPage(this.id, keepSelection); }
	public toggleElementSelection(enabled?: boolean, options?: IBrowserElementSelectionOptions): Promise<void> { return this.service.toggleElementSelection(this.id, enabled, options); }
	public setElementComments(update: IBrowserElementCommentsUpdate): Promise<void> { return this.service.setElementComments(this.id, update); }
	public toggleAreaSelection(enabled?: boolean): Promise<void> { return this.service.toggleAreaSelection(this.id, enabled); }
	public captureScreenshot(options?: IBrowserViewCaptureScreenshotOptions): Promise<VSBuffer> { return this.service.captureScreenshot(this.id, options); }

	public loadURL(url: string): Promise<void> { return this.service.loadURL(this.id, url); }
	public goBack(): Promise<void> { return this.service.goBack(this.id); }
	public goForward(): Promise<void> { return this.service.goForward(this.id); }
	public reload(hard?: boolean): Promise<void> { return this.service.reload(this.id, hard); }
	public stop(): Promise<void> { return this.service.stop(this.id); }
	public focus(): Promise<void> { return this.service.focus(this.id); }
	public layout(bounds: IBrowserViewBounds): Promise<void> { return this.service.layout(this.id, bounds); }
	public setVisible(visible: boolean): Promise<void> { return this.service.setVisible(this.id, visible); }
	public getSharing(): Promise<readonly string[]> { return this.service.getSharing(this.id); }
	public setSharing(threadIds: readonly string[]): Promise<void> { return this.service.setSharing(this.id, threadIds); }
	protected override disposeCore(): void { this.disposing.fire(); super.disposeCore(); }
}
