import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { IWebview, IWebviewElement, IWebviewService, WebviewInitInfo } from './webview.js';
import { WebviewElement } from './webviewElement.js';

export class WebviewService extends Disposable implements IWebviewService {
	declare readonly _serviceBrand: undefined;
	private readonly views = this._register(new DisposableMap<IWebview, DisposableStore>());
	private readonly activeChanged = this._register(new Emitter<IWebview | undefined>());
	public readonly onDidChangeActiveWebview = this.activeChanged.event;
	private focusedWebview: IWebview | undefined;

	constructor(@IInstantiationService private readonly instantiation: IInstantiationService) {
		super();
		this._register(toDisposable(() => this.setActiveWebview(undefined)));
	}

	public get activeWebview(): IWebview | undefined { return this.focusedWebview; }
	public get webviews(): Iterable<IWebview> { return this.views.keys(); }

	public createWebviewElement(initInfo: WebviewInitInfo): IWebviewElement {
		this.assertNotDisposed();
		const webview = this.instantiation.createInstance(WebviewElement, initInfo);
		const listeners = this.views.set(webview, new DisposableStore());
		listeners.add(webview.onDidFocus(() => this.setActiveWebview(webview)));
		listeners.add(webview.onDidBlur(() => {
			if (this.focusedWebview === webview) {
				this.setActiveWebview(undefined);
			}
		}));
		listeners.add(webview.onDidDispose(() => {
			if (this.focusedWebview === webview) {
				this.setActiveWebview(undefined);
			}
			this.views.deleteAndDispose(webview);
		}));
		return webview;
	}

	private setActiveWebview(webview: IWebview | undefined): void {
		if (this.focusedWebview === webview) {
			return;
		}
		this.focusedWebview = webview;
		this.activeChanged.fire(webview);
	}
}
