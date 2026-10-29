import { type Color } from '../../base/common/color.js';
import { Emitter, type Event } from '../../base/common/event.js';
import { Disposable, type IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { ColorId } from './encodedTokenAttributes.js';
import { type ILazyTokenizationSupport, type ITokenizationRegistry, type ITokenizationSupportChangedEvent } from './languages.js';

export class TokenizationRegistry<TSupport> implements ITokenizationRegistry<TSupport> {
	private readonly supports = new Map<string, TSupport>();
	private readonly factories = new Map<string, SupportFactory<TSupport>>();
	private readonly changeEmitter = new Emitter<ITokenizationSupportChangedEvent>();
	private colors: Color[] | null = null;

	readonly onDidChange: Event<ITokenizationSupportChangedEvent> = this.changeEmitter.event;

	handleChange(languageIds: string[]): void {
		this.changeEmitter.fire({ changedLanguages: [...languageIds], changedColorMap: false });
	}

	register(languageId: string, support: TSupport): IDisposable {
		this.supports.set(languageId, support);
		this.handleChange([languageId]);
		return toDisposable(() => {
			if (this.supports.get(languageId) !== support) return;
			this.supports.delete(languageId);
			this.handleChange([languageId]);
		});
	}

	registerFactory(languageId: string, factory: ILazyTokenizationSupport<TSupport>): IDisposable {
		this.factories.get(languageId)?.dispose();
		const pending = new SupportFactory(this, languageId, factory);
		this.factories.set(languageId, pending);
		this.handleChange([languageId]);
		return toDisposable(() => {
			if (this.factories.get(languageId) !== pending) return;
			this.factories.delete(languageId);
			pending.dispose();
			this.handleChange([languageId]);
		});
	}

	get(languageId: string): TSupport | null {
		return this.supports.get(languageId) ?? null;
	}

	async getOrCreate(languageId: string): Promise<TSupport | null> {
		const current = this.get(languageId);
		if (current) return current;
		await this.factories.get(languageId)?.resolve();
		return this.get(languageId);
	}

	isResolved(languageId: string): boolean {
		return this.supports.has(languageId) || (this.factories.get(languageId)?.isResolved ?? true);
	}

	setColorMap(colorMap: Color[]): void {
		this.colors = [...colorMap];
		this.changeEmitter.fire({ changedLanguages: [...this.supports.keys()], changedColorMap: true });
	}

	getColorMap(): Color[] | null {
		return this.colors ? [...this.colors] : null;
	}

	getDefaultBackground(): Color | null {
		return this.colors?.[ColorId.DefaultBackground] ?? null;
	}
}

class SupportFactory<TSupport> extends Disposable {
	private resolved = false;
	private resolving: Promise<void> | undefined;

	get isResolved(): boolean {
		return this.resolved;
	}

	constructor(
		private readonly registry: TokenizationRegistry<TSupport>,
		private readonly languageId: string,
		private readonly factory: ILazyTokenizationSupport<TSupport>,
	) {
		super();
	}

	resolve(): Promise<void> {
		this.resolving ??= this.load();
		return this.resolving;
	}

	private async load(): Promise<void> {
		const support = await this.factory.tokenizationSupport;
		this.resolved = true;
		if (support && !this.isDisposed) this._register(this.registry.register(this.languageId, support));
	}
}
