import { addDisposableListener, getWindow, runWhenWindowIdle } from '../../../../base/browser/dom.js';
import { DisposableMap, Disposable, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { type IEditorContribution } from '../../../common/editorCommon.js';
import { type ICodeEditor } from '../../editorBrowser.js';
import { EditorContributionInstantiation, type IEditorContributionDescription } from '../../editorExtensions.js';

interface PendingCodeEditorContribution {
	readonly id: string;
	readonly ctor: IEditorContributionDescription['ctor'];
	readonly instantiation: EditorContributionInstantiation;
}

/** Owns one CodeEditorWidget's contribution instances and their staged creation. */
export class CodeEditorContributions extends Disposable {
	private editor: ICodeEditor | null = null;
	private readonly instances = this._register(new DisposableMap<string, IEditorContribution>());
	private readonly pending = new Map<string, PendingCodeEditorContribution>();
	private readonly completedInstantiation = new Set<EditorContributionInstantiation>();
	private onError: (error: unknown) => void = reportContributionError;

	constructor(@IInstantiationService private readonly instantiationService: IInstantiationService) {
		super();
		this._register(toDisposable(() => this.pending.clear()));
	}

	initialize(
		editor: ICodeEditor,
		descriptions: readonly IEditorContributionDescription[],
		onError?: (error: unknown) => void,
	): void {
		this.assertNotDisposed();
		if (this.editor) throw new Error('Code editor contributions have already been initialized');
		if (typeof onError === 'function') this.onError = onError;
		this.editor = editor;
		const incomingIds = new Set<string>();
		for (const description of descriptions) {
			if (!isValidDescription(description)) throw new TypeError('Code editor contribution is invalid');
			if (incomingIds.has(description.id)) {
				throw new RangeError(`Duplicate code editor contribution '${description.id}'`);
			}
			incomingIds.add(description.id);
		}
		for (const description of descriptions) {
			this.pending.set(description.id, {
				id: description.id,
				ctor: description.ctor,
				instantiation: description.instantiation,
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
		for (const [contributionId, instance] of this.instances) {
			if (contributionId === id) return instance;
		}
		return null;
	}

	set(id: string, value: IEditorContribution): void {
		this.pending.delete(id);
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
			const instance = this.instantiationService.createInstance(pending.ctor, this.editor);
			if (!instance || typeof instance.dispose !== 'function') throw new TypeError(`Code editor contribution '${id}' did not return a disposable`);
			this.instances.set(id, instance);
			if (pending.instantiation !== EditorContributionInstantiation.Eager && (typeof instance.saveViewState === 'function' || typeof instance.restoreViewState === 'function')) {
				console.warn(`Editor contribution '${id}' should be eager because it owns view state.`);
			}
		} catch (error) {
			this.onError(error);
		}
	}
}

function isValidDescription(description: IEditorContributionDescription): boolean {
	return Boolean(
		description
			&& typeof description.id === 'string'
			&& description.id.trim().length > 0
			&& description.ctor
			&& isInstantiation(description.instantiation),
	);
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
