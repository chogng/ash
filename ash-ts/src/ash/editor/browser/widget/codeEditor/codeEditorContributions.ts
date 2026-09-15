import { addDisposableListener, getWindow, runWhenWindowIdle } from '../../../../base/browser/dom.js';
import { DisposableMap, DisposableStore, Disposable, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { type IEditorContribution } from '../../../common/editorCommon.js';
import { type ICodeEditor } from '../../editorBrowser.js';
import { EditorContributionInstantiation, type EditorContributionRegistration, type TextEditorContributionConfigurationContext, type TextEditorContributionContext } from '../../editorExtensions.js';

interface PendingCodeEditorContribution {
	readonly id: string;
	readonly create: () => IEditorContribution;
	readonly instantiation: EditorContributionInstantiation;
}

/** Owns one CodeEditorWidget's contribution instances and their staged creation. */
export class CodeEditorContributions extends Disposable {
	private editor: ICodeEditor | null = null;
	private descriptions: readonly EditorContributionRegistration[] | undefined;
	private readonly instances = new Map<string, IEditorContribution>();
	private readonly resources = this._register(new DisposableMap<string, DisposableStore>());
	private readonly pending = new Map<string, PendingCodeEditorContribution>();
	private readonly completedInstantiation = new Set<EditorContributionInstantiation>();
	private onError: (error: unknown) => void = reportContributionError;

	constructor(@IInstantiationService private readonly instantiationService: IInstantiationService) {
		super();
		this._register(toDisposable(() => { this.pending.clear(); this.instances.clear(); this.descriptions = undefined; }));
	}

	/** Configure model services before the View is constructed. */
	configure(descriptions: readonly EditorContributionRegistration[], context: TextEditorContributionConfigurationContext): void {
		this.assertNotDisposed();
		if (this.descriptions) throw new Error('Code editor contributions have already been configured');
		validateDescriptions(descriptions);
		this.descriptions = descriptions.slice();
		for (const description of this.descriptions) {
			const resources = new DisposableStore();
			this.resources.set(description.id, resources);
			if (!('ctor' in description) && description.configure) {
				// Model sources must outlive the View; installation resources end before it.
				const configuration = context.register(new DisposableStore());
				description.configure({ ...context, register: value => configuration.add(value) });
			}
		}
	}

	initialize(
		editor: ICodeEditor,
		context: TextEditorContributionContext,
		onError?: (error: unknown) => void,
	): void {
		this.assertNotDisposed();
		if (this.editor) throw new Error('Code editor contributions have already been initialized');
		if (typeof onError === 'function') this.onError = onError;
		this.editor = editor;
		if (!this.descriptions) throw new ReferenceError('Code editor contributions have not been configured');
		for (const description of this.descriptions) {
			if ('ctor' in description) {
				this.pending.set(description.id, {
					id: description.id,
					create: () => this.instantiationService.createInstance(description.ctor, editor),
					instantiation: description.instantiation,
				});
				continue;
			}
			const resources = this.resources.get(description.id)!;
			const contributionContext = { ...context, register: <T extends IDisposable>(value: T): T => resources.add(value) };
			this.pending.set(description.id, {
				id: description.id,
				instantiation: description.instantiation ?? EditorContributionInstantiation.Eager,
				create: () => {
					try {
						return description.install?.(contributionContext) ?? resources;
					} catch (error) {
						resources.dispose();
						throw error;
					}
				},
			});
		}
		this.instantiateSome(EditorContributionInstantiation.Eager);

		const domNode = editor.getDomNode();
		if (!domNode) throw new ReferenceError('Code editor contributions require an editor DOM node');
		for (const type of ['pointerdown', 'wheel', 'contextmenu', 'dragover', 'drop', 'keydown', 'beforeinput', 'compositionstart', 'paste', 'cut'] as const) {
			this._register(addDisposableListener(domNode, type, () => this.onBeforeInteractionEvent(), true));
		}
		const targetWindow = getWindow(domNode);
		this._register(runWhenWindowIdle(targetWindow, () => this.instantiateSome(EditorContributionInstantiation.BeforeFirstInteraction)));
		this._register(runWhenWindowIdle(targetWindow, () => this.instantiateSome(EditorContributionInstantiation.Eventually), 5_000));
	}

	saveViewState(): { [key: string]: unknown } {
		const state: { [key: string]: unknown } = {};
		for (const [id, contribution] of this.instances) {
			if (typeof contribution.saveViewState === 'function') state[id] = contribution.saveViewState();
		}
		return state;
	}

	restoreViewState(state: { [key: string]: unknown }): void {
		for (const [id, contribution] of this.instances) {
			if (typeof contribution.restoreViewState === 'function') contribution.restoreViewState(state[id]);
		}
	}

	get(id: string): IEditorContribution | null {
		this.instantiateById(id);
		return this.instances.get(id) ?? null;
	}

	set(id: string, value: IEditorContribution): void {
		this.pending.delete(id);
		const resources = new DisposableStore();
		resources.add(value);
		this.resources.set(id, resources);
		this.instances.set(id, value);
	}

	onBeforeInteractionEvent(): void {
		this.instantiateSome(EditorContributionInstantiation.BeforeFirstInteraction);
	}

	onAfterModelAttached(): IDisposable {
		const domNode = this.editor?.getDomNode();
		if (!domNode) return Disposable.None;
		return runWhenWindowIdle(getWindow(domNode), () => this.instantiateSome(EditorContributionInstantiation.AfterFirstRender), 50);
	}

	private instantiateSome(instantiation: EditorContributionInstantiation): void {
		if (this.isDisposed || this.completedInstantiation.has(instantiation)) return;
		this.completedInstantiation.add(instantiation);
		const pending = [...this.pending.values()].filter(value => value.instantiation === instantiation);
		for (const value of pending) this.instantiateById(value.id);
	}

	private instantiateById(id: string): void {
		if (this.isDisposed) return;
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		try {
			const instance = pending.create();
			if (!instance || typeof instance.dispose !== 'function') throw new TypeError(`Code editor contribution '${id}' did not return a disposable`);
			const resources = this.resources.get(id)!;
			if (instance !== resources) resources.add(instance);
			this.instances.set(id, instance);
			if (pending.instantiation !== EditorContributionInstantiation.Eager && (typeof instance.saveViewState === 'function' || typeof instance.restoreViewState === 'function')) {
				console.warn(`Editor contribution '${id}' should be eager because it owns view state.`);
			}
		} catch (error) {
			this.onError(error);
		}
	}
}

function validateDescriptions(descriptions: readonly EditorContributionRegistration[]): void {
	const ids = new Set<string>();
	for (const description of descriptions) {
		if (!description?.id?.trim() || ('ctor' in description
			? !description.ctor || !isInstantiation(description.instantiation)
			: !(description.configure || description.install) || (description.instantiation !== undefined && !isInstantiation(description.instantiation)))) {
			throw new TypeError('Code editor contribution is invalid');
		}
		if (ids.has(description.id)) throw new RangeError(`Duplicate code editor contribution '${description.id}'`);
		ids.add(description.id);
	}
}

function isInstantiation(value: EditorContributionInstantiation): boolean {
	return value === EditorContributionInstantiation.Eager
		|| value === EditorContributionInstantiation.AfterFirstRender
		|| value === EditorContributionInstantiation.BeforeFirstInteraction
		|| value === EditorContributionInstantiation.Eventually
		|| value === EditorContributionInstantiation.Lazy;
}

function reportContributionError(error: unknown): void {
	console.error('Code editor contribution failed', error);
}
