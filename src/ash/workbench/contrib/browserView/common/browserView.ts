import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { IBrowserViewService, type BrowserViewEvent, type IBrowserViewBounds, type IBrowserViewCreateOptions, type IBrowserViewInfo, type IBrowserViewState } from '../../../../platform/browserView/common/browserView.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrowserEditorInput, IBrowserEditorInputData } from './browserEditorInput.js';

export const IBrowserViewWorkbenchService = createServiceIdentifier<IBrowserViewWorkbenchService>('browserViewWorkbenchService');

export interface IBrowserViewWorkbenchService {
	initialize(): Promise<void>;
	getKnownBrowserViews(): ReadonlyMap<string, BrowserEditorInput>;
	getOrCreateLazy(data: IBrowserEditorInputData): BrowserEditorInput;
	createBrowserView(options: IBrowserViewCreateOptions): Promise<BrowserEditorInput>;
}

export interface IBrowserViewModel extends IDisposable {
	readonly id: string;
	readonly state: IBrowserViewState;
	readonly info: IBrowserViewInfo;
	readonly onDidChangeState: Event<IBrowserViewState>;
	readonly onDidClose: Event<void>;
	readonly onDidEvent: Event<BrowserViewEvent>;
	loadURL(url: string): Promise<void>;
	goBack(): Promise<void>;
	goForward(): Promise<void>;
	reload(): Promise<void>;
	stop(): Promise<void>;
	focus(): Promise<void>;
	layout(bounds: IBrowserViewBounds): Promise<void>;
	setVisible(visible: boolean): Promise<void>;
	getSharing(): Promise<readonly string[]>;
	setSharing(threadIds: readonly string[]): Promise<void>;
}

/** A renderer read model. Only Main computes page state; commands return to the same page owner. */
export class BrowserViewModel extends Disposable implements IBrowserViewModel {
	private readonly stateChanges = this._register(new Emitter<IBrowserViewState>());
	public readonly onDidChangeState = this.stateChanges.event;
	private readonly closed = this._register(new Emitter<void>());
	public readonly onDidClose = this.closed.event;
	private readonly events = this._register(new Emitter<BrowserViewEvent>());
	public readonly onDidEvent = this.events.event;
	private currentState: IBrowserViewState;
	private stateRevision = 0;

	constructor(private readonly initialInfo: IBrowserViewInfo, @IBrowserViewService private readonly service: IBrowserViewService) {
		super();
		this.currentState = initialInfo.state;
		this._register(service.onDidEvent(event => {
			const id = event.type === 'created' ? event.info.id : event.type === 'stateChanged' ? event.state.targetId : event.targetId;
			if (id !== this.id) { return; }
			if (event.type === 'stateChanged' && event.state.targetId === this.id) {
				this.stateRevision++;
				this.currentState = event.state;
				this.stateChanges.fire(event.state);
			} else if (event.type === 'closed' && event.targetId === this.id) {
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
		if (revision === this.stateRevision) {
			this.currentState = state;
			this.stateChanges.fire(state);
		}
	}

	public loadURL(url: string): Promise<void> { return this.service.loadURL(this.id, url); }
	public goBack(): Promise<void> { return this.service.goBack(this.id); }
	public goForward(): Promise<void> { return this.service.goForward(this.id); }
	public reload(): Promise<void> { return this.service.reload(this.id); }
	public stop(): Promise<void> { return this.service.stop(this.id); }
	public focus(): Promise<void> { return this.service.focus(this.id); }
	public layout(bounds: IBrowserViewBounds): Promise<void> { return this.service.layout(this.id, bounds); }
	public setVisible(visible: boolean): Promise<void> { return this.service.setVisible(this.id, visible); }
	public getSharing(): Promise<readonly string[]> { return this.service.getSharing(this.id); }
	public setSharing(threadIds: readonly string[]): Promise<void> { return this.service.setSharing(this.id, threadIds); }
}
