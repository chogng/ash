import { h } from '../../dom.js';
import { cancelOnDispose } from '../../../common/cancellation.js';
import { isCancellationError, onUnexpectedError } from '../../../common/errors.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../common/lifecycle.js';
import type { IPagedModel } from '../../../common/paging.js';
import type { IListRenderer, IListVirtualDelegate } from './list.js';
import { List, type ListOptions } from './listWidget.js';

export interface IPagedRenderer<TElement, TTemplateData> extends IListRenderer<TElement, TTemplateData> {
	renderPlaceholder(index: number, templateData: TTemplateData): void;
}

export interface IPagedListOptions<T> extends Pick<ListOptions<T>, 'ariaLabel' | 'role' | 'accessibilityProvider' | 'multipleSelectionSupport' | 'mouseSupport'> {
	readonly keyboardSupport?: boolean;
}

interface RenderedPageRow<T> {
	readonly renderer: IPagedRenderer<T, any>;
	readonly data: any;
	readonly request: MutableDisposable<DisposableStore>;
	index: number;
	element: T | undefined;
}

/** Resolves rendered indexes while the supplied model remains the sole owner of paged data. */
export class PagedList<T> extends Disposable {
	public readonly widget: List<number>;
	private _model!: IPagedModel<T>;
	private readonly modelResources = this._register(new DisposableStore());
	private readonly rowResources = this._register(new DisposableMap<HTMLElement, DisposableStore>());
	private readonly rows = new WeakMap<HTMLElement, RenderedPageRow<T>>();
	private readonly renderers: Map<string, IPagedRenderer<T, any>>;

	constructor(user: string, container: HTMLElement, private readonly virtualDelegate: IListVirtualDelegate<number>, renderers: IPagedRenderer<T, any>[], options: IPagedListOptions<T> = {}) {
		super();
		this.renderers = new Map(renderers.map(renderer => [renderer.templateId, renderer]));
		const accessibilityProvider = options.accessibilityProvider;
		const resolvedRole = options.role === 'tree' ? 'treeitem' : 'option';
		this.widget = this._register(new List<number>(container, {
			ariaLabel: options.ariaLabel ?? user,
			role: options.role,
			multipleSelectionSupport: options.multipleSelectionSupport,
			mouseSupport: options.mouseSupport,
			keyboardNavigation: options.keyboardSupport ?? true,
			scrolling: 'managed',
			getId: String,
			getHeight: index => virtualDelegate.getHeight(index),
			reuseRows: true,
			domFocusable: options.keyboardSupport !== false,
			accessibilityProvider: {
				getRole: index => this.model.isResolved(index) ? accessibilityProvider?.getRole?.(this.model.get(index)) ?? resolvedRole : 'presentation',
				getAriaLabel: index => this.model.isResolved(index) ? accessibilityProvider?.getAriaLabel?.(this.model.get(index)) : undefined,
				getAriaLevel: index => this.model.isResolved(index) ? accessibilityProvider?.getAriaLevel?.(this.model.get(index)) : undefined,
				getAriaSetSize: index => this.model.isResolved(index) ? accessibilityProvider?.getAriaSetSize?.(this.model.get(index)) : undefined,
				getAriaPosInSet: index => this.model.isResolved(index) ? accessibilityProvider?.getAriaPosInSet?.(this.model.get(index)) : undefined,
				isExpanded: index => this.model.isResolved(index) ? accessibilityProvider?.isExpanded?.(this.model.get(index)) : undefined,
			},
			renderItem: (index, _position, row) => {
				const templateId = virtualDelegate.getTemplateId(index);
				const renderer = this.renderers.get(templateId);
				if (!renderer) {
					throw new Error(`Missing paged list renderer: ${templateId}`);
				}
				const contents = h(container.ownerDocument, 'div');
				const resources = new DisposableStore();
				const state: RenderedPageRow<T> = {
					renderer,
					data: renderer.renderTemplate(contents),
					request: resources.add(new MutableDisposable<DisposableStore>()),
					index,
					element: undefined,
				};
				resources.add(toDisposable(() => {
					state.request.clear();
					if (state.element !== undefined) {
						renderer.disposeElement?.(state.element, state.index, state.data);
					}
					renderer.disposeTemplate(state.data);
				}));
				this.rowResources.set(row, resources);
				this.rows.set(row, state);
				this.renderRow(state);
				return contents;
			},
			updateItem: (index, _position, row) => {
				const state = this.rows.get(row)!;
				state.index = index;
				this.renderRow(state);
			},
			onDidRemoveRow: row => {
				this.rowResources.deleteAndDispose(row);
				this.rows.delete(row);
			},
		}));
		this._register(this.widget.onDidRenderRows(() => {
			// Retained templates keep their content, but offscreen rows no longer own a pending request.
			for (const [row] of this.rowResources) {
				if (!row.isConnected) {
					this.rows.get(row)!.request.clear();
				}
			}
		}));
	}

	public get model(): IPagedModel<T> {
		return this._model;
	}

	public set model(model: IPagedModel<T>) {
		this.modelResources.clear();
		this.widget.items = [];
		this.widget.clearRetainedRows();
		this._model = model;
		this.modelResources.add(model.onDidIncrementLength(() => this.refreshIndexes()));
		this.refreshIndexes();
	}

	private refreshIndexes(): void {
		this.widget.items = Array.from({ length: this.model.length }, (_, index) => index);
	}

	private renderRow(state: RenderedPageRow<T>): void {
		const model = this.model;
		if (model.isResolved(state.index)) {
			state.request.clear();
			state.element = model.get(state.index);
			state.renderer.renderElement(state.element, state.index, state.data, { height: this.virtualDelegate.getHeight(state.index) });
			return;
		}
		if (state.request.value) {
			return;
		}
		state.renderer.renderPlaceholder(state.index, state.data);
		const request = new DisposableStore();
		state.request.value = request;
		void this.resolveRow(state, model, request).catch(onUnexpectedError);
	}

	private async resolveRow(state: RenderedPageRow<T>, model: IPagedModel<T>, request: DisposableStore): Promise<void> {
		const token = cancelOnDispose(request);
		try {
			try {
				await model.resolve(state.index, token);
			} catch (error) {
				if (!token.isCancellationRequested && !isCancellationError(error)) {
					// The model's owner supplies error and retry content through the placeholder renderer.
					state.renderer.renderPlaceholder(state.index, state.data);
				}
				return;
			}
			if (!token.isCancellationRequested) {
				// Rebind through List so a resolved placeholder also receives its role, label and height.
				this.widget.updateElementHeight(state.index, undefined);
			}
		} finally {
			if (state.request.value === request) {
				state.request.clear();
			}
		}
	}
}
