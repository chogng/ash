import { Disposable, MutableDisposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { encodeBase64 } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IChatContextPickService, type ChatContextPick } from '../../../../services/chat/common/chatContextService.js';
import type { IBrowserViewModel } from '../../common/browserView.js';
import type { IElementData } from '../../../../../platform/browserView/common/browserView.js';

const selections = new WeakMap<IBrowserViewModel, BrowserPageSelections>();

/** Split editors borrow one attachment source for the lifetime of their shared page model. */
export class BrowserEditorChatIntegration extends Disposable {
	private readonly binding = this._register(new MutableDisposable<IDisposable>());
	private current: BrowserPageSelections | undefined;

	constructor(@IInstantiationService private readonly instantiation: IInstantiationService) { super(); }

	public setModel(model: IBrowserViewModel | undefined, changed: (message: string) => void): void {
		if (this.current?.model === model) { return; }
		this.binding.clear();
		this.current = undefined;
		if (!model) { return; }
		let source = selections.get(model);
		if (!source) {
			source = this.instantiation.createInstance(BrowserPageSelections, model);
			selections.set(model, source);
		}
		this.current = source;
		this.binding.value = source.attach(changed);
	}

	public getAccessibleContent(): string { return this.current?.getAccessibleContent() ?? ''; }
}

/** Main owns the page; this model-scoped source owns immutable user-selected context snapshots. */
class BrowserPageSelections extends Disposable {
	private readonly snapshots = new Map<string, ChatContextPick>();
	private readonly comments = new Map<string, string>();
	private readonly status = this._register(new Emitter<string>());
	private epoch = 0;
	private areaSequence = 0;
	private leases = 0;

	constructor(public readonly model: IBrowserViewModel, @IChatContextPickService contexts: IChatContextPickService) {
		super();
		this._register(contexts.registerPicker({
			id: 'browser.selection.' + crypto.randomUUID(),
			label: localize({ bundle: 'ash.workbench', key: 'browser.selectionContext' }, 'Browser selections'),
			isEnabled: () => this.snapshots.size > 0,
			providePicks: async query => [...this.snapshots.values()].filter(item => (item.label + ' ' + item.description).toLowerCase().includes(query.toLowerCase())),
		}));
		this._register(model.onWillDispose(() => this.dispose()));
		this._register(model.onDidClose(() => this.dispose()));
		this._register(model.onDidEvent(event => {
			if (event.type === 'elementPicked') {
				this.acceptElement(event.data);
				this.status.fire(localize({ bundle: 'ash.workbench', key: 'browser.selectionCaptured' }, 'Selection captured. Choose Browser selections from Chat’s Add Context menu to attach it.'));
			} else if (event.type === 'elementCommentRemoved') {
				this.comments.delete(event.elementId);
				this.snapshots.delete(event.elementId);
				void this.publishComments().catch(error => this.status.fire(String(error)));
			} else if (event.type === 'areaPicked') {
				const epoch = this.epoch;
				void model.captureScreenshot({ format: 'png', screenRect: event.rect, awaitNextPaint: true }).then(image => {
					if (epoch !== this.epoch || this.isDisposed) { return; }
					const id = 'area:' + ++this.areaSequence;
					const name = localize({ bundle: 'ash.workbench', key: 'browser.areaScreenshot' }, 'Browser area {0}', this.areaSequence);
					const content = 'data:image/png;base64,' + encodeBase64(image);
					this.addSnapshot(id, {
						label: name, description: model.state.url, attachment: {
							id: model.id + ':' + id, name, kind: 'image', resource: URI.parse(model.state.url),
							resolve: async () => ({ name, kind: 'image', content }),
						}
					});
					this.status.fire(localize({ bundle: 'ash.workbench', key: 'browser.areaCaptured' }, 'Area captured. Choose Other context sources in Chat’s Add context menu to attach the screenshot.'));
				}).catch(error => { if (epoch === this.epoch && !this.isDisposed) { this.status.fire(String(error)); } });
			} else if (event.type === 'stateChanged' && event.state.loading) {
				this.epoch++;
				this.snapshots.clear();
				this.comments.clear();
			}
		}));
	}

	public attach(changed: (message: string) => void): IDisposable {
		this.leases++;
		const listener = this.status.event(changed);
		return toDisposable(() => {
			listener.dispose();
			if (--this.leases === 0 && !this.isDisposed) { this.stopSelection(); }
		});
	}

	private stopSelection(): void {
		void this.model.toggleElementSelection(false).catch(() => { });
		void this.model.toggleAreaSelection(false).catch(() => { });
	}

	private acceptElement(element: IElementData): void {
		if (!element.elementId) { return; }
		const name = element.comment || element.innerText?.slice(0, 80) || localize({ bundle: 'ash.workbench', key: 'browser.selectedElement' }, 'Selected browser element');
		const url = element.url ?? this.model.state.url;
		const content = [url, element.comment ?? '', element.outerHTML, element.computedStyle].filter(Boolean).join('\n\n');
		this.addSnapshot(element.elementId, {
			label: name, description: url, attachment: {
				id: this.model.id + ':' + element.elementId, name, kind: 'browserElement', resource: URI.parse(url), resolve: async () => ({ name, content }),
			}
		});
		if (element.comment) {
			this.comments.set(element.elementId, element.comment);
			void this.publishComments().catch(error => this.status.fire(String(error)));
		}
	}

	private addSnapshot(id: string, pick: ChatContextPick): void {
		if (!this.snapshots.has(id) && this.snapshots.size >= 50) {
			const retired = this.snapshots.keys().next().value!;
			this.snapshots.delete(retired);
			this.comments.delete(retired);
		}
		this.snapshots.set(id, pick);
	}

	private publishComments(): Promise<void> { return this.model.setElementComments({ comments: [...this.comments].map(([elementId, body]) => ({ elementId, body })) }); }
	public getAccessibleContent(): string { return [...this.snapshots.values()].map(item => item.label + '\n' + item.description).join('\n\n'); }
	protected override disposeCore(): void {
		this.epoch++;
		this.stopSelection();
		void this.model.setElementComments({ comments: [] }).catch(() => { });
		this.snapshots.clear();
		this.comments.clear();
		selections.delete(this.model);
		super.disposeCore();
	}
}
