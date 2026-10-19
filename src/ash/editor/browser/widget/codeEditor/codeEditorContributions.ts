import { addDisposableListener, getWindow, runWhenWindowIdle } from '../../../../base/browser/dom.js';
import { DisposableMap, DisposableStore, Disposable, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { type IEditorContribution } from '../../../common/editorCommon.js';
import { type ICodeEditor } from '../../editorBrowser.js';
import { EditorContributionInstantiation, type EditorContributionRegistration, type TextEditorContributionConfigurationContext, type TextEditorContributionContext } from '../../editorExtensions.js';

interface PendingCodeEditorContribution {
	readonly id: string;
	readonly create: () => IEditorContribution | void;
	readonly instantiation: EditorContributionInstantiation;
}

interface ProviderScope extends DisposableStore {
	readonly services: ReturnType<IInstantiationService['createChild']>;
	readonly ids: Set<string>;
}

/** Owns one CodeEditorWidget's contribution instances and their staged creation. */
export class CodeEditorContributions extends Disposable {
	private editor: ICodeEditor | null = null;
	private descriptions: readonly EditorContributionRegistration[] | undefined;
	private readonly instances = new Map<string, IEditorContribution>();
	private readonly providerScopes = this._register(new DisposableMap<AbortSignal, ProviderScope>());
	private readonly resources = this._register(new DisposableMap<string, DisposableStore>());
	private configurationContext: TextEditorContributionConfigurationContext | undefined;
	private installationContext: TextEditorContributionContext | undefined;
	private readonly configurations = new Map<string, DisposableStore>();
	private readonly pending = new Map<string, PendingCodeEditorContribution>();
	private readonly completedInstantiation = new Set<EditorContributionInstantiation>();
	private onError: (error: unknown) => void = reportContributionError;

	constructor(@IInstantiationService private readonly instantiationService: IInstantiationService) {
		super();
		this._register(toDisposable(() => {
			this.pending.clear();
			this.instances.clear();
			this.configurations.clear();
			this.descriptions = undefined;
			this.configurationContext = undefined;
			this.installationContext = undefined;
			this.editor = null;
		}));
	}

	/** The initial batch configures model services before the View is constructed. */
	configure(descriptions: readonly EditorContributionRegistration[], context: TextEditorContributionConfigurationContext): void {
		this.assertNotDisposed();
		if (this.descriptions) throw new Error('Code editor contributions have already been configured');
		this.configurationContext = context;
		this.descriptions = [];
		this.refresh(descriptions);
	}

	/** Newly admitted providers may attach to an existing view without replacing its text model. */
	refresh(descriptions: readonly EditorContributionRegistration[]): void {
		this.assertNotDisposed();
		validateDescriptions(descriptions);
		const context = this.configurationContext;
		if (!context || !this.descriptions) throw new ReferenceError('Code editor contributions have not been configured');
		const added: EditorContributionRegistration[] = [];
		try {
			for (const description of descriptions) {
				if (description.providerSignal?.aborted || this.descriptions.includes(description)) continue;
				if (this.descriptions.some(current => current.id === description.id)) this.retire(description.id);
				this.descriptions = [...this.descriptions, description];
				const resources = new DisposableStore();
				this.resources.set(description.id, resources);
				const scope = description.providerSignal ? this.providerScope(description.providerSignal) : undefined;
				scope?.ids.add(description.id);
				added.push(description);
				if (!('ctor' in description) && description.configure) {
					const configuration = scope ? scope.add(new DisposableStore()) : context.register(new DisposableStore());
					this.configurations.set(description.id, configuration);
					description.configure({
						...context,
						...(scope ? {
							getService: scope.services.get.bind(scope.services),
							getOptionalService: scope.services.getOptional.bind(scope.services),
							provideService: scope.services.registerInstance.bind(scope.services),
						} : {}),
						register: value => configuration.add(value),
					});
				}
			}
		} catch (error) {
			for (const description of added.reverse()) this.retire(description.id);
			throw error;
		}
		if (!this.installationContext) return;
		// Configure the complete batch before any controller reads another contribution's service.
		for (const description of added) this.schedule(description);
		for (const description of added) {
			const phase = 'ctor' in description ? description.instantiation : description.instantiation ?? EditorContributionInstantiation.Eager;
			if (this.completedInstantiation.has(phase)) this.instantiateById(description.id);
		}
	}

	private providerScope(signal: AbortSignal): ProviderScope {
		let scope = this.providerScopes.get(signal);
		if (scope) return scope;
		const resources = new DisposableStore();
		scope = Object.assign(resources, {
			services: resources.add(this.instantiationService.createChild()),
			ids: new Set<string>(),
		});
		this.providerScopes.set(signal, scope);
		resources.add(addDisposableListener(signal, 'abort', () => {
			const current = this.providerScopes.get(signal);
			if (!current) return;
			for (const id of [...current.ids]) this.retire(id);
			this.providerScopes.deleteAndDispose(signal);
		}, { once: true }));
		return scope;
	}

	private schedule(description: EditorContributionRegistration): void {
		const editor = this.editor;
		const context = this.installationContext;
		const resources = this.resources.get(description.id);
		if (!editor || !context || !resources || description.providerSignal?.aborted) return;
		const scope = description.providerSignal ? this.providerScopes.get(description.providerSignal) : undefined;
		if ('ctor' in description) {
			const services = scope?.services ?? this.instantiationService;
			this.pending.set(description.id, {
				id: description.id,
				create: () => services.createInstance(description.ctor, editor),
				instantiation: description.instantiation,
			});
			return;
		}
		if (!description.install) return;
		const contributionContext = {
			...context,
			...(scope ? {
				instantiationService: scope.services,
				getService: scope.services.get.bind(scope.services),
				getOptionalService: scope.services.getOptional.bind(scope.services),
			} : {}),
			register: <T extends IDisposable>(value: T): T => resources.add(value),
		};
		this.pending.set(description.id, {
			id: description.id,
			instantiation: description.instantiation ?? EditorContributionInstantiation.Eager,
			create: () => {
				try { return description.install?.(contributionContext); }
				catch (error) { resources.dispose(); throw error; }
			},
		});
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
		this.installationContext = context;
		for (const description of this.descriptions) this.schedule(description);
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

	saveViewState(): { [key: string]: unknown; } {
		const state: { [key: string]: unknown; } = {};
		for (const [id, contribution] of this.instances) {
			if (typeof contribution.saveViewState === 'function') state[id] = contribution.saveViewState();
		}
		return state;
	}

	restoreViewState(state: { [key: string]: unknown; }): void {
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

	private retire(id: string): void {
		const description = this.descriptions?.find(current => current.id === id);
		this.descriptions = this.descriptions?.filter(current => current.id !== id);
		this.pending.delete(id);
		this.instances.delete(id);
		try {
			this.resources.deleteAndDispose(id);
		} catch (error) {
			this.onError(error);
		} finally {
			// Retirement ends provider work immediately; the shared text model and view stay alive.
			const configuration = this.configurations.get(id);
			try { configuration?.dispose(); } catch (error) { this.onError(error); }
			this.configurations.delete(id);
			const signal = description?.providerSignal;
			const scope = signal ? this.providerScopes.get(signal) : undefined;
			if (scope) {
				if (configuration) scope.delete(configuration);
				scope.ids.delete(id);
				if (scope.ids.size === 0) this.providerScopes.deleteAndDispose(signal!);
			}
		}
	}

	private instantiateById(id: string): void {
		if (this.isDisposed) return;
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		try {
			const instance = pending.create();
			if (instance === undefined) return;
			if (!instance || typeof instance.dispose !== 'function') throw new TypeError(`Code editor contribution '${id}' did not return a disposable`);
			const resources = this.resources.get(id);
			if (!resources || resources.isDisposed) {
				instance.dispose();
				return;
			}
			// Preserve the installation order when the controller is already owned.
			if (!resources.has(instance)) resources.add(instance);
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
