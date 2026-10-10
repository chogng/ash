import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import type { IBrowserViewModel } from '../common/browserView.js';
import { BrowserOverlayManager } from './overlayManager.js';

export function focusWebContentsViewContainer(container: HTMLElement): void {
	container.focus();
	container.ownerDocument.getSelection()?.removeAllRanges();
}

interface PagePresentation {
	readonly hosts: Set<WebContentsViewHost>;
	update: Promise<void>;
	queued: boolean;
	closed: boolean;
	revision: number;
}

// Splits borrow one model and one compositor page. Serialize their presentation commands together.
const presentations = new WeakMap<IBrowserViewModel, PagePresentation>();

/** Owns page geometry, compositor visibility and focus without owning the editor or page. */
export class WebContentsViewHost extends Disposable {
	private container: HTMLElement | undefined;
	private model: IBrowserViewModel | undefined;
	private visible = false;
	private focusRequested = false;
	private readonly modelListeners = this._register(new DisposableStore());
	private readonly overlays: BrowserOverlayManager;

	constructor(
		targetWindow: Window & typeof globalThis,
		@IInstantiationService instantiation: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.overlays = this._register(instantiation.createInstance(BrowserOverlayManager, targetWindow));
		this._register(this.overlays.onDidChangeOverlayState(() => this.layout()));
	}

	public onContainerCreated(container: HTMLElement): void {
		this.assertNotDisposed();
		if (this.container) { throw new Error('Browser container is already attached'); }
		this.container = container;
		this._register(addDisposableListener(container, 'focus', () => this.tryFocus()));
		this._register(addDisposableListener(container, 'blur', () => { this.focusRequested = false; }));
		const observer = new container.ownerDocument.defaultView!.ResizeObserver(() => this.layout());
		observer.observe(container);
		this._register(toDisposable(() => observer.disconnect()));
		this.layout();
	}

	public setModel(model: IBrowserViewModel | undefined): void {
		if (this.model === model) { return; }
		const previous = this.model;
		this.modelListeners.clear();
		this.model = model;
		this.focusRequested = false;
		if (previous) {
			presentations.get(previous)!.hosts.delete(this);
			this.schedule(previous);
		}
		if (model) {
			let presentation = presentations.get(model);
			if (!presentation) {
				presentation = { hosts: new Set(), update: Promise.resolve(), queued: false, closed: false, revision: 0 };
				presentations.set(model, presentation);
			}
			presentation.hosts.add(this);
			this.modelListeners.add(model.onDidClose(() => {
				presentation.closed = true;
				this.setModel(undefined);
			}));
			this.schedule(model);
		}
	}

	public setVisible(visible: boolean): void {
		this.visible = visible;
		if (visible && this.model) { this.claim(this.model); }
		this.layout();
	}

	public layout(): void {
		if (this.model && !this.isDisposed) { this.schedule(this.model); }
	}

	public tryFocus(): boolean {
		if (!this.model || !this.visible || !this.container || this.overlays.getOverlappingOverlays(this.container).length > 0) { return false; }
		this.claim(this.model);
		this.focusRequested = true;
		if (this.container.ownerDocument.activeElement !== this.container) { focusWebContentsViewContainer(this.container); }
		this.schedule(this.model);
		return true;
	}

	protected override disposeCore(): void {
		this.setModel(undefined);
		super.disposeCore();
	}

	private claim(model: IBrowserViewModel): void {
		const hosts = presentations.get(model)!.hosts;
		hosts.delete(this);
		hosts.add(this);
	}

	private schedule(model: IBrowserViewModel): void {
		const presentation = presentations.get(model)!;
		presentation.revision++;
		if (presentation.queued || presentation.closed) { return; }
		presentation.queued = true;
		presentation.update = presentation.update.then(async () => {
			presentation.queued = false;
			if (presentation.closed) { return; }
			const revision = presentation.revision;
			const host = [...presentation.hosts].reverse().find(candidate => candidate.visible && candidate.container && !candidate.isDisposed);
			const container = host?.container;
			const bounds = container?.getBoundingClientRect();
			const visible = !!(host && container && bounds && bounds.width > 0 && bounds.height > 0 && host.overlays.getOverlappingOverlays(container).length === 0);
			if (visible && bounds) {
				await model.layout({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) });
			}
			if (presentation.closed || revision !== presentation.revision) { return; }
			await model.setVisible(visible);
			// IPC can finish after the pane switches input or an overlay takes keyboard focus.
			if (visible && host?.focusRequested && host.model === model && host.visible && container?.ownerDocument.activeElement === container && host.overlays.getOverlappingOverlays(container).length === 0) {
				host.focusRequested = false;
				await model.focus();
			}
		}).catch(error => {
			if (!presentation.closed) { this.logService.error('browserView', 'Failed to present browser page', error); }
		});
	}
}
