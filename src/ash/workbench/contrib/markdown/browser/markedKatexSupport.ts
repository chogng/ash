import '../../../../../../extensions/markdown-math/src/styles.css';
import { raceCancellationError, RunOnceScheduler } from '../../../../base/common/async.js';
import { localize } from '../../../../nls.js';
import { isRecord } from '../../../../base/common/types.js';
import { sanitizeHtmlToFragment } from '../../../../base/browser/domSanitize.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import {
	IExtensionHostApi,
	type ExtensionHostFleetSnapshot,
	type ExtensionHostRuntime,
} from '../../../../platform/agentHost/common/extensionHostApi.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { SanitizeAttributeRule } from '../../../../base/browser/domSanitize.js';
import type { MarkdownSanitizerConfig } from '../../../../base/browser/markdownRenderer.js';
import type { MarkedExtension } from '../../../../base/common/marked/marked.js';
import { katexContainerLatexAttributeName, MarkedKatexExtension } from '../common/markedKatexExtension.js';

const mathTags = [
	'math',
	'semantics',
	'annotation',
	'mrow',
	'mi',
	'mn',
	'mo',
	'mtext',
	'mspace',
	'msub',
	'msup',
	'msubsup',
	'mfrac',
	'msqrt',
	'mroot',
	'mtable',
	'mtr',
	'mtd',
	'munder',
	'mover',
	'munderover',
	'menclose',
	'mstyle',
	'mpadded',
	'mphantom',
	'mmultiscripts',
	'mprescripts',
	'none',
	'svg',
	'path',
	'line',
	'text',
	'title',
	'desc',
];
const mathAttributes = [
	'xmlns',
	'display',
	'stretchy',
	'fence',
	'separator',
	'mathvariant',
	'displaystyle',
	'scriptlevel',
	'lspace',
	'rspace',
	'movablelimits',
	'accent',
	'accentunder',
	'columnalign',
	'columnspacing',
	'rowspacing',
	'linethickness',
	'encoding',
	'd',
	'viewBox',
	'preserveAspectRatio',
	katexContainerLatexAttributeName,
	'data-math-display',
];
const styleProperties = new Set([
	'color',
	'background-color',
	'display',
	'top',
	'left',
	'right',
	'bottom',
	'width',
	'height',
	'min-width',
	'min-height',
	'max-width',
	'max-height',
	'margin',
	'margin-left',
	'margin-right',
	'margin-top',
	'margin-bottom',
	'padding-left',
	'padding-right',
	'vertical-align',
	'font-size',
	'font-style',
	'font-weight',
	'text-align',
	'border-width',
	'border-bottom-width',
	'border-top-width',
	'border-right-width',
	'border-color',
	'border-style',
]);

type MathResult =
	| { readonly status: 'rendered'; readonly html: string }
	| {
			readonly status: 'source';
			readonly diagnostic:
				{ readonly code: 'invalidFormula'; readonly message: string } | { readonly code: 'outputLimit' };
	  };

/** Validate the complete optional-provider response before changing any formula nodes. */
function parseMathResults(value: unknown, count: number): readonly MathResult[] {
	if (
		!isRecord(value) ||
		Object.keys(value).length !== 1 ||
		!Array.isArray(value.results) ||
		value.results.length !== count ||
		new TextEncoder().encode(JSON.stringify(value)).byteLength > 512 * 1024
	) {
		throw new TypeError('Invalid math render response');
	}
	return value.results.map((result: unknown) => {
		if (!isRecord(result) || Object.keys(result).length !== 2) {
			throw new TypeError('Invalid math formula result');
		}
		if (result.status === 'rendered' && typeof result.html === 'string') {
			return { status: 'rendered', html: result.html };
		}
		if (result.status === 'source' && isRecord(result.diagnostic)) {
			const diagnostic = result.diagnostic;
			if (diagnostic.code === 'outputLimit' && Object.keys(diagnostic).length === 1) {
				return { status: 'source', diagnostic: { code: 'outputLimit' } };
			}
			if (
				diagnostic.code === 'invalidFormula' &&
				Object.keys(diagnostic).length === 2 &&
				typeof diagnostic.message === 'string' &&
				new TextEncoder().encode(diagnostic.message).byteLength <= 2048
			) {
				return { status: 'source', diagnostic: { code: 'invalidFormula', message: diagnostic.message } };
			}
		}
		throw new TypeError('Invalid math formula result');
	});
}

interface MathBatch {
	readonly controller: AbortController;
	readonly start: RunOnceScheduler;
	readonly release: RunOnceScheduler;
	readonly result: Promise<readonly MathResult[]>;
	consumers: number;
	bytes: number;
	completed: boolean;
}

/** Owns shared batches for one chat renderer; no formula renderer runs in the browser. */
export class MarkedKatexSupport extends Disposable {
	private snapshot: Promise<ExtensionHostFleetSnapshot> | undefined;
	private providerIdentity: string | undefined;
	private readonly batches = new Map<string, MathBatch>();
	constructor(
		@IExtensionHostApi private readonly host: IExtensionHostApi,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		const changed = host.onDidChange(() => {
			this.snapshot = undefined;
		});
		this._register(toDisposable(() => changed.dispose()));
		const connection = host.onConnectionState(() => {
			this.snapshot = undefined;
			this.clearBatches();
		});
		this._register(toDisposable(() => connection.dispose()));
		this._register(
			configuration.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('markdown.math')) {
					this.snapshot = undefined;
					this.clearBatches();
				}
			}),
		);
		this._register(toDisposable(() => this.clearBatches()));
	}

	private clearBatches(): void {
		for (const key of this.batches.keys()) {
			this.removeBatch(key);
		}
	}

	private removeBatch(key: string): void {
		const batch = this.batches.get(key);
		if (batch) {
			batch.controller.abort();
			batch.start.dispose();
			batch.release.dispose();
			this.batches.delete(key);
		}
	}

	private async getSnapshot(): Promise<ExtensionHostFleetSnapshot> {
		const pending = (this.snapshot ??= this.host.list().then(snapshot => {
			const runtime = snapshot.extensions.find(entry => entry.id === 'ash.markdown-math');
			return !this.isDisposed &&
				this.configuration.getValue<boolean>('markdown.math.enabled') !== false &&
				runtime?.lifecycle === 'dormant'
				? this.host.activateByEvent({
						extensionId: runtime.id,
						activationGeneration: runtime.activationGeneration,
						event: { type: 'capability', capability: 'math.render.v2' },
					})
				: snapshot;
		}));
		try {
			const snapshot = await pending;
			if (this.isDisposed || this.snapshot !== pending) {
				throw new Error('Math provider changed');
			}
			const runtime = snapshot.extensions.find(entry => entry.id === 'ash.markdown-math');
			const identity = JSON.stringify([
				runtime?.activationGeneration,
				runtime?.incarnation,
				runtime?.lifecycle,
				runtime?.registrations,
			]);
			if (identity !== this.providerIdentity) {
				this.clearBatches();
				this.providerIdentity = identity;
			}
			return snapshot;
		} catch (error) {
			if (this.snapshot === pending) {
				this.snapshot = undefined;
			}
			throw error;
		}
	}

	private acquireBatch(
		runtime: ExtensionHostRuntime,
		registrationId: string,
		formulas: readonly { source: string; display: string }[],
	): { result: Promise<readonly MathResult[]>; dispose(): void } {
		const macros = { ...this.configuration.getValue<Record<string, string>>('markdown.math.macros') };
		// Cache the entire ordered batch: a preceding formula may define macros used
		// by every subsequent formula. Text-only keys would break that scope.
		const key = JSON.stringify([
			runtime.activationGeneration,
			runtime.incarnation,
			registrationId,
			formulas,
			Object.entries(macros).sort(([a], [b]) => a.localeCompare(b)),
		]);
		let batch = this.batches.get(key);
		if (!batch) {
			const controller = new AbortController();
			let resolve!: (results: readonly MathResult[]) => void;
			let reject!: (error: unknown) => void;
			const result = new Promise<readonly MathResult[]>((yes, no) => {
				resolve = yes;
				reject = no;
			});
			controller.signal.addEventListener('abort', () => reject(new Error('Math render retired')), { once: true });
			const start = new RunOnceScheduler(() => {
				void (async () => {
					const value = await this.host.invoke(
						{
							extensionId: runtime.id,
							activationGeneration: runtime.activationGeneration,
							incarnation: runtime.incarnation!,
							registrationId,
							operation: 'receiveData',
							payload: { formulas: [...formulas], macros },
							deadlineUnixMillis: Date.now() + 30_000,
						},
						controller.signal,
					);
					controller.signal.throwIfAborted();
					const results = parseMathResults(value, formulas.length);
					entry.bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
					entry.completed = true;
					resolve(results);
					this.trimBatches();
				})().catch(error => {
					if (this.batches.get(key) === entry) {
						this.removeBatch(key);
					}
					reject(error);
				});
			}, 32);
			// A replacement streaming render can acquire the batch in this event turn.
			const release = new RunOnceScheduler(() => {
				if (!entry.consumers && !entry.completed) {
					this.removeBatch(key);
				}
				this.trimBatches();
			}, 0);
			const entry: MathBatch = (batch = {
				controller,
				start,
				release,
				result,
				consumers: 0,
				bytes: new TextEncoder().encode(key).byteLength,
				completed: false,
			});
			this.batches.set(key, entry);
			start.schedule();
		}
		const entry = batch;
		entry.release.cancel();
		entry.consumers++;
		// Refresh insertion order for a small renderer-owned LRU. Active consumers
		// own their requests; only unreferenced completed results are evictable.
		this.batches.delete(key);
		this.batches.set(key, entry);
		return {
			result: entry.result,
			dispose: () => {
				if (--entry.consumers === 0 && !entry.controller.signal.aborted) {
					entry.release.schedule();
				}
			},
		};
	}

	private trimBatches(): void {
		let bytes = [...this.batches.values()].reduce((sum, batch) => sum + batch.bytes, 0);
		for (const [key, batch] of this.batches) {
			if (this.batches.size <= 8 && bytes <= 2 * 1024 * 1024) {
				break;
			}
			if (batch.completed && !batch.consumers) {
				bytes -= batch.bytes;
				this.removeBatch(key);
			}
		}
	}

	public static getSanitizerOptions(baseConfig: {
		readonly allowedTags: readonly string[];
		readonly allowedAttributes: ReadonlyArray<string | SanitizeAttributeRule>;
	}): MarkdownSanitizerConfig {
		const dimensions: SanitizeAttributeRule[] = ['width', 'height'].map(attributeName => {
			const base = [...baseConfig.allowedAttributes]
				.reverse()
				.find(
					attribute =>
						(typeof attribute === 'string' ? attribute : attribute.attributeName) === attributeName,
				);
			return {
				attributeName,
				shouldKeep: (element, data) => {
					if (element.namespaceURI === 'http://www.w3.org/2000/svg' && element.localName === 'svg') {
						const length = /^(\d+(?:\.\d+)?|\.\d+)(?:em|ex|px|%)?$/u.exec(data.attrValue);
						return !!length && Number(length[1]) <= 1000;
					}
					return typeof base === 'string' || (base?.shouldKeep(element, data) ?? false);
				},
			};
		});
		return {
			allowedTags: { override: [...new Set([...baseConfig.allowedTags, ...mathTags])] },
			allowedAttributes: {
				override: [
					...baseConfig.allowedAttributes,
					...mathAttributes,
					...dimensions,
					{
						attributeName: 'style',
						shouldKeep: (_element, data) => {
							// Keep only bounded numeric/keyword declarations. URL-bearing CSS,
							// custom properties, expressions and arbitrary functions never reach DOM.
							return data.attrValue
								.split(';')
								.flatMap(declaration => {
									const separator = declaration.indexOf(':');
									const property = declaration.slice(0, separator).trim().toLowerCase();
									const value = declaration.slice(separator + 1).trim();
									return styleProperties.has(property) &&
										/^(?:-?(?:\d*\.)?\d+(?:em|ex|px|pt|rem|%)?|[a-z-]+|#[\da-f]{3,8})(?:\s+(?:-?(?:\d*\.)?\d+(?:em|ex|px|pt|rem|%)?|[a-z-]+)){0,3}$/iu.test(
											value,
										)
										? [`${property}:${value}`]
										: [];
								})
								.join(';');
						},
					},
				],
			},
		};
	}

	public static getExtension(): MarkedExtension {
		return MarkedKatexExtension.extension();
	}

	/** One message owns its batch, macro scope and cancellation lifetime. */
	public renderMath(root: HTMLElement, didRender?: () => void): IDisposable {
		this.assertNotDisposed();
		const store = new DisposableStore();
		const elements = [...root.querySelectorAll<HTMLElement>('.ash-katex-container[data-latex][data-math-display]')];
		if (!elements.length) {
			return store;
		}
		const formulas = elements.map(element => ({
			source: element.getAttribute(katexContainerLatexAttributeName)!,
			display: element.getAttribute('data-math-display') === 'block' ? 'block' : 'inline',
		}));
		const sources = elements.map(element => element.textContent ?? '');
		let controller: AbortController | undefined;
		let identity: string | undefined;
		let generation = 0;
		let connectionEpoch = 0;
		let revision = 0;
		const restoreSources = (): void => {
			for (const [index, element] of elements.entries()) {
				element.textContent = sources[index];
				element.removeAttribute('title');
				element.removeAttribute('data-math-diagnostic');
			}
		};
		const provider = (snapshot: ExtensionHostFleetSnapshot): ExtensionHostRuntime | undefined =>
			snapshot.extensions.find(runtime => runtime.id === 'ash.markdown-math');
		const providerIdentity = (runtime: ExtensionHostRuntime | undefined): string =>
			JSON.stringify([
				runtime?.activationGeneration,
				runtime?.incarnation,
				runtime?.lifecycle,
				runtime?.registrations,
			]);
		const refresh = async (force = false): Promise<void> => {
			const epoch = connectionEpoch;
			const currentRevision = ++revision;
			if (force) {
				controller?.abort();
				restoreSources();
			}
			if (this.configuration.getValue<boolean>('markdown.math.enabled') === false) {
				controller?.abort();
				restoreSources();
				didRender?.();
				return;
			}
			try {
				const snapshot = await this.getSnapshot();
				if (
					store.isDisposed ||
					epoch !== connectionEpoch ||
					currentRevision !== revision ||
					snapshot.generation < generation
				) {
					return;
				}
				generation = snapshot.generation;
				const runtime = provider(snapshot);
				const nextIdentity = providerIdentity(runtime);
				// Fleet output advances generation too; only a provider change invalidates formulas.
				if (!force && identity === nextIdentity) {
					return;
				}
				identity = nextIdentity;
				controller?.abort();
				const request = (controller = new AbortController());
				restoreSources();
				if (this.configuration.getValue<boolean>('markdown.math.enabled') === false || !runtime) {
					didRender?.();
					return;
				}
				const registration = runtime?.registrations.find(
					entry => entry.kind === 'dataChannel' && entry.channelId === 'math.render.v2',
				);
				if (!runtime || runtime.lifecycle !== 'ready' || runtime.incarnation === undefined || !registration) {
					return;
				}
				const batch = this.acquireBatch(runtime, registration.registrationId, formulas);
				const release = toDisposable(() => batch.dispose());
				const aborted = (): void => release.dispose();
				request.signal.addEventListener('abort', aborted, { once: true });
				try {
					const results = await raceCancellationError(batch.result, request.signal);
					request.signal.throwIfAborted();
					const sanitizer = MarkedKatexSupport.getSanitizerOptions({
						allowedTags: ['span'],
						allowedAttributes: ['class', 'aria-hidden'],
					});
					const fragments = results.map(result =>
						result.status === 'rendered'
							? sanitizeHtmlToFragment(result.html, {
									ownerDocument: root.ownerDocument,
									config: sanitizer,
								})
							: undefined,
					);
					for (const [index, result] of results.entries()) {
						const element = elements[index];
						if (result.status === 'rendered') {
							element.replaceChildren(fragments[index]!);
						} else {
							element.dataset.mathDiagnostic = result.diagnostic.code;
							element.title =
								result.diagnostic.code === 'invalidFormula'
									? `${localize('markdown.math.invalidFormula', 'This formula could not be rendered.')}\n${result.diagnostic.message}`
									: localize(
											'markdown.math.outputLimit',
											'This formula exceeds the rendering output limit.',
										);
						}
					}
					didRender?.();
				} finally {
					request.signal.removeEventListener('abort', aborted);
					// The live DOM owns its markup after installation. Retaining a lease
					// here would keep completed HTML alive beyond the bounded cache.
					release.dispose();
				}
			} catch {
				// Missing, disabled or failed optional providers leave readable formula source.
			}
		};
		store.add(toDisposable(() => controller?.abort()));
		store.add(
			this.configuration.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('markdown.math')) {
					void refresh(true);
				}
			}),
		);
		const changed = this.host.onDidChange(() => {
			void refresh();
		});
		store.add(toDisposable(() => changed.dispose()));
		const connection = this.host.onConnectionState(state => {
			connectionEpoch++;
			if (state !== 'ready') {
				controller?.abort();
				identity = undefined;
				generation = 0;
				restoreSources();
				didRender?.();
			} else {
				void refresh(true);
			}
		});
		store.add(toDisposable(() => connection.dispose()));
		void refresh();
		return store;
	}
}
