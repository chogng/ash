import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { colorCssVariable } from '../../../../platform/theme/common/colorUtils.js';
import type { IDecoration, IDecorationData, IDecorationsProvider, IDecorationsService, IResourceDecorationChangeEvent } from '../common/decorations.js';

interface CachedDecoration {
	readonly resource: URI;
	readonly cancellation: CancellationTokenSource;
	data: IDecorationData | undefined;
}

interface ProviderState {
	readonly provider: IDecorationsProvider;
	readonly resources: DisposableStore;
	readonly cache: Map<string, CachedDecoration>;
}

interface DecorationStyle {
	readonly className: string;
	readonly data: IDecorationData;
	references: number;
}

/** Resolves provider data independently of labels; labels own only their style handles. */
export class DecorationsService extends Disposable implements IDecorationsService {
	private readonly providers = new Set<ProviderState>();
	private readonly changed = this._register(new Emitter<IResourceDecorationChangeEvent>());
	private readonly styles = new Map<string, DecorationStyle>();
	private readonly style: HTMLStyleElement;
	private nextStyleId = 0;
	public readonly onDidChangeDecorations = this.changed.event;

	constructor(document: Document, @ILogService private readonly logService: ILogService) {
		super();
		this.style = document.createElement('style');
		this.style.dataset.ashDecorations = '';
		document.head.append(this.style);
		this._register(toDisposable(() => this.style.remove()));
	}

	public registerDecorationsProvider(provider: IDecorationsProvider): IDisposable {
		this.assertNotDisposed();
		const state: ProviderState = { provider, resources: new DisposableStore(), cache: new Map() };
		this.providers.add(state);
		state.resources.add(provider.onDidChange(resources => {
			const affected = resources.length ? resources : [...state.cache.values()].map(entry => entry.resource);
			for (const [key, entry] of state.cache) {
				if (!resources.length || resources.some(resource => extUriBiasedIgnorePathCase.isEqualOrParent(entry.resource, resource))) {
					entry.cancellation.dispose(true);
					state.cache.delete(key);
				}
			}
			this.fireChange(affected);
		}));
		this.fireChange();
		return toDisposable(() => {
			if (!this.providers.delete(state)) {
				return;
			}
			this.releaseProvider(state);
			this.fireChange();
		});
	}

	public getDecoration(uri: URI, includeChildren: boolean): IDecoration | undefined {
		this.assertNotDisposed();
		const candidates: IDecorationData[] = [];
		for (const state of this.providers) {
			const key = extUriBiasedIgnorePathCase.getComparisonKey(uri);
			let entry = state.cache.get(key);
			if (!entry) {
				entry = { resource: uri, cancellation: new CancellationTokenSource(), data: undefined };
				state.cache.set(key, entry);
				this.query(state, key, entry);
			}
			if (entry.data) {
				candidates.push(entry.data);
			}
			if (includeChildren) {
				for (const child of state.cache.values()) {
					if (child !== entry && child.data?.bubble && extUriBiasedIgnorePathCase.isEqualOrParent(child.resource, uri)) {
						candidates.push(child.data);
					}
				}
			}
		}
		if (!candidates.length) {
			return undefined;
		}
		candidates.sort((left, right) => (right.weight ?? 0) - (left.weight ?? 0));
		const data: IDecorationData = { color: candidates.find(candidate => candidate.color)?.color, letter: candidates.find(candidate => candidate.letter !== undefined)?.letter };
		const signature = JSON.stringify([data.color, data.letter]);
		let style = this.styles.get(signature);
		if (!style) {
			const className = `ash-decoration-${++this.nextStyleId}`;
			style = { className, data, references: 0 };
			this.styles.set(signature, style);
			this.updateStyles();
		}
		style.references += 1;
		const handle = toDisposable(() => {
			if (--style.references === 0) {
				this.styles.delete(signature);
				this.updateStyles();
			}
		});
		return Object.assign(handle, {
			tooltip: [...new Set(candidates.flatMap(candidate => candidate.tooltip ? [candidate.tooltip] : []))].join(' • '),
			strikethrough: candidates.some(candidate => candidate.strikethrough),
			labelClassName: data.color ? `${style.className}-color` : '',
			badgeClassName: typeof data.letter === 'string' ? `${style.className}-badge` : '',
			iconClassName: data.letter && typeof data.letter !== 'string' ? `${style.className}-icon` : '',
			isTextBadge: typeof data.letter === 'string',
			icon: data.letter && typeof data.letter !== 'string' ? ThemeIcon.modify(data.letter, undefined) : undefined,
		});
	}

	private query(state: ProviderState, key: string, entry: CachedDecoration): void {
		try {
			const result = state.provider.provideDecorations(entry.resource, entry.cancellation.token);
			if (result instanceof Promise) {
				void result.then(data => {
					// Invalidated or removed providers must never publish a result from an old query.
					if (state.cache.get(key) !== entry || this.isDisposed) {
						return;
					}
					entry.data = data;
					entry.cancellation.dispose();
					this.fireChange([entry.resource]);
				}, error => this.reportError(state, entry, error));
			} else {
				entry.data = result;
				entry.cancellation.dispose();
			}
		} catch (error) {
			this.reportError(state, entry, error);
		}
	}

	private reportError(state: ProviderState, entry: CachedDecoration, error: unknown): void {
		if (!entry.cancellation.token.isCancellationRequested && !isCancellationError(error)) {
			this.logService.error('decorations', `Unable to query ${state.provider.label}`, error);
		}
		entry.cancellation.dispose();
	}

	private fireChange(resources?: readonly URI[]): void {
		this.changed.fire({ affectsResource: uri => !resources || resources.some(resource => extUriBiasedIgnorePathCase.isEqualOrParent(uri, resource) || extUriBiasedIgnorePathCase.isEqualOrParent(resource, uri)) });
	}

	private releaseProvider(state: ProviderState): void {
		state.resources.dispose();
		for (const entry of state.cache.values()) {
			entry.cancellation.dispose(true);
		}
		state.cache.clear();
	}

	private updateStyles(): void {
		this.style.textContent = [...this.styles.values()].map(({ className, data }) => {
			const rules: string[] = [];
			if (data.color) {
				rules.push(`.ash-icon-label.${className}-color > .ash-icon-label-container { color: var(${colorCssVariable(data.color)}); }`);
			}
			if (typeof data.letter === 'string') {
				rules.push(`.ash-icon-label.${className}-badge::after { content: ${cssString(data.letter)}; flex: 0 0 auto; font-size: var(--ash-font-size-label2); color: ${data.color ? `var(${colorCssVariable(data.color)})` : 'inherit'}; }`);
			} else if (data.letter) {
				const color = data.letter.color?.id ?? data.color;
				rules.push(`.ash-icon-label.${className}-icon { --ash-icon-label-suffix-icon-color: ${color ? `var(${colorCssVariable(color)})` : 'currentColor'}; }`);
			}
			return rules.join('\n');
		}).join('\n');
	}

	protected override disposeCore(): void {
		for (const state of this.providers) {
			this.releaseProvider(state);
		}
		this.providers.clear();
		this.styles.clear();
		super.disposeCore();
	}
}

function cssString(value: string): string {
	return `"${value.replace(/["\\\x00-\x1f\x7f]/gu, character => `\\${character.codePointAt(0)!.toString(16)} `)}"`;
}
