import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { type URI } from '../../../../base/common/uri.js';
import { IDataChannelService, ILinkPresentationService, type CoreDataChannel, type IDataChannelEvent, type ILinkPresentationProvider, type ILinkPresentationProviderRegistration, type ILinkPresentationRule, type ILinkPresentationWatcher } from '../../../../platform/dataChannel/common/dataChannel.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import type { ContextKeyExpression } from '../../../../platform/contextkey/common/contextkey.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

export class DataChannelService extends Disposable implements IDataChannelService {
	public readonly _serviceBrand = undefined;
	private readonly sendEmitter = this._register(new Emitter<IDataChannelEvent>());
	public readonly onDidSendData = this.sendEmitter.event;

	public getDataChannel<T>(channelId: string): CoreDataChannel<T> {
		this.assertNotDisposed();
		return {
			sendData: data => {
				this.assertNotDisposed();
				this.sendEmitter.fire({ channelId, data });
			}
		};
	}
}

interface ProviderEntry {
	readonly registration: ILinkPresentationProviderRegistration;
	readonly provider: ILinkPresentationProvider;
	readonly watchers: DisposableStore;
	readonly enablement: ContextKeyExpression | undefined;
}

export class LinkPresentationService extends Disposable implements ILinkPresentationService {
	public readonly _serviceBrand = undefined;
	private readonly providers = new Map<string, ProviderEntry>();
	private readonly rulesEmitter = this._register(new Emitter<void>());
	public readonly onDidChangeLinkPresentationRules = this.rulesEmitter.event;

	constructor(@IContextKeyService private readonly contextKeyService: IContextKeyService) {
		super();
		this._register(contextKeyService.onDidChangeContext(event => {
			const affected = [...this.providers.values()].filter(entry => entry.enablement && event.affectsSome(entry.enablement.keys()));
			if (affected.length === 0) {
				return;
			}
			for (const entry of affected) {
				if (!this.isEnabled(entry)) {
					entry.watchers.clear();
				}
			}
			this.rulesEmitter.fire();
		}));
		this._register(toDisposable(() => this.providers.clear()));
	}

	public get linkPresentationRules(): readonly ILinkPresentationRule[] {
		return [...this.providers.values()].filter(entry => this.isEnabled(entry)).map(({ registration }) => ({ id: registration.id, uriPattern: registration.uriPattern, kind: registration.kind }));
	}

	public registerLinkPresentationProvider(registration: ILinkPresentationProviderRegistration, provider: ILinkPresentationProvider): IDisposable {
		this.assertNotDisposed();
		if (this.providers.has(registration.id)) {
			throw new Error(`Link presentation provider '${registration.id}' is already registered`);
		}
		const enablement = registration.enablement ? ContextKeyExpr.deserialize(registration.enablement) : undefined;
		const watchers = this._register(new DisposableStore());
		const entry = { registration, provider, watchers, enablement };
		this.providers.set(registration.id, entry);
		this.rulesEmitter.fire();
		return toDisposable(() => {
			this.providers.delete(registration.id);
			this._store.delete(watchers);
			watchers.dispose();
			this.rulesEmitter.fire();
		});
	}

	public getLinkPresentationRule(resource: URI): ILinkPresentationRule | undefined {
		return this.linkPresentationRules.find(rule => {
			rule.uriPattern.lastIndex = 0;
			return rule.uriPattern.test(resource.toString());
		});
	}

	public createLinkPresentationWatcher(providerId: string, resource: URI): ILinkPresentationWatcher | undefined {
		this.assertNotDisposed();
		const entry = this.providers.get(providerId);
		if (!entry || !this.isEnabled(entry)) {
			return undefined;
		}
		entry.registration.uriPattern.lastIndex = 0;
		if (!entry.registration.uriPattern.test(resource.toString())) {
			return undefined;
		}
		const watcher = entry.provider.createLinkPresentationWatcher(resource);
		entry.watchers.add(watcher);
		return Object.assign(toDisposable(() => {
			entry.watchers.delete(watcher);
			watcher.dispose();
		}), { presentation: watcher.presentation });
	}

	private isEnabled(entry: ProviderEntry): boolean {
		return this.contextKeyService.contextMatchesRules(entry.enablement);
	}
}

registerSingleton(IDataChannelService, DataChannelService, InstantiationType.Delayed);
registerSingleton(ILinkPresentationService, LinkPresentationService, InstantiationType.Delayed);
