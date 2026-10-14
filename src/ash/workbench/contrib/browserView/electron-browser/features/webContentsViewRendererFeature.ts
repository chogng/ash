import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IBrowserViewModel } from '../../common/browserView.js';
import { WebContentsViewHost } from '../webContentsViewHost.js';

/** Owns page presentation policy; the host owns compositor bounds, overlap and focus coordination. */
export class WebContentsViewRendererFeature extends Disposable {
	public readonly host: WebContentsViewHost;
	private model: IBrowserViewModel | undefined;
	private visible = false;
	private readonly binding = this._register(new DisposableStore());
	constructor(window: Window, @IInstantiationService instantiation: IInstantiationService) {
		super();
		this.host = this._register(instantiation.createInstance(WebContentsViewHost, window));
	}
	public setModel(model: IBrowserViewModel | undefined): void {
		this.binding.clear();
		this.model = model;
		this.host.setModel(model);
		if (model) { this.binding.add(model.onDidChangeState(() => this.update())); }
		this.update();
	}
	public setVisible(visible: boolean): void { this.visible = visible; this.update(); }
	private update(): void {
		// Chromium paints above the DOM: the welcome content requires hiding the blank native view.
		this.host.setVisible(this.visible && !!this.model && (this.model.state.url !== 'about:blank' || this.model.state.loading));
	}
}
