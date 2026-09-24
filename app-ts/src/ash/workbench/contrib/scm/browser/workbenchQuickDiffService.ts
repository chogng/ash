import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { type URI } from '../../../../base/common/uri.js';
import { type IQuickDiffService, type QuickDiffOriginalResource, type QuickDiffProvider } from '../common/quickDiff.js';

interface ProviderRegistration {
	readonly provider: QuickDiffProvider;
	readonly listeners: DisposableStore;
}

/** Window-scoped provider registry and visibility owner for Quick Diff. */
export class WorkbenchQuickDiffService extends Disposable implements IQuickDiffService {
	private readonly changeEmitter = this._register(new Emitter<URI | undefined>());
	private readonly registrations: ProviderRegistration[] = [];
	private readonly hiddenProviders = new Set<string>();

	readonly onDidChange = this.changeEmitter.event;

	constructor() {
		super();
		this._register(toDisposable(() => {
			for (const registration of this.registrations) registration.listeners.dispose();
			this.registrations.length = 0;
			this.hiddenProviders.clear();
		}));
	}

	get providers(): readonly QuickDiffProvider[] {
		return Object.freeze(this.registrations.map(registration => registration.provider));
	}

	addProvider(provider: QuickDiffProvider): IDisposable {
		this.assertNotDisposed();
		validateProvider(provider);
		if (this.registrations.some(registration => registration.provider.id === provider.id)) {
			throw new RangeError(`Quick Diff provider '${provider.id}' is already registered`);
		}
		const listeners = new DisposableStore();
		if (provider.onDidChange) listeners.add(provider.onDidChange(resource => this.changeEmitter.fire(resource)));
		const registration = { provider, listeners };
		this.registrations.push(registration);
		this.changeEmitter.fire(undefined);
		return toDisposable(() => {
			const index = this.registrations.indexOf(registration);
			if (index < 0) return;
			this.registrations.splice(index, 1);
			listeners.dispose();
			this.changeEmitter.fire(undefined);
		});
	}

	isProviderVisible(providerId: string): boolean {
		return !this.hiddenProviders.has(providerId);
	}

	setProviderVisible(providerId: string, visible: boolean): void {
		this.assertNotDisposed();
		if (!this.registrations.some(registration => registration.provider.id === providerId)) {
			throw new ReferenceError(`Unknown Quick Diff provider '${providerId}'`);
		}
		const changed = visible ? this.hiddenProviders.delete(providerId) : !this.hiddenProviders.has(providerId);
		if (!visible) this.hiddenProviders.add(providerId);
		if (changed) this.changeEmitter.fire(undefined);
	}

	async getQuickDiffs(resource: URI, signal: AbortSignal): Promise<readonly QuickDiffOriginalResource[]> {
		this.assertNotDisposed();
		signal.throwIfAborted();
		const providers = this.registrations
			.map(registration => registration.provider)
			.filter(provider => this.isProviderVisible(provider.id) && containsResource(provider.rootUri, resource));
		const results = await Promise.all(providers.map(provider => provider.provideOriginalResource(resource, signal)));
		signal.throwIfAborted();
		return Object.freeze(results.filter((result): result is QuickDiffOriginalResource => result !== undefined));
	}
}

function validateProvider(provider: QuickDiffProvider): void {
	if (!provider || !provider.id?.trim() || !provider.label?.trim() || typeof provider.provideOriginalResource !== 'function') {
		throw new TypeError('Quick Diff provider is invalid');
	}
}

function containsResource(root: URI | undefined, resource: URI): boolean {
	if (!root) return true;
	if (root.scheme !== resource.scheme || root.authority !== resource.authority) return false;
	const rootPath = root.path.replace(/\/$/u, '');
	return resource.path === rootPath || resource.path.startsWith(`${rootPath}/`);
}
