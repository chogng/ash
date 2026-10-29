import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { observableValue, type IObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IRendererHostService, type IRendererHost } from '../../../../platform/renderer/common/rendererHost.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type { SymphonyControl, SymphonyMessage, SymphonySnapshot } from '../../../../platform/symphony/common/symphonyService.js';

export const SymphonyNavigationId = 'sessions.navigation.symphony';
export const SymphonyMonitorResource = URI.from({ scheme: 'ash-symphony', path: '/monitor' });
export interface SymphonyViewState extends SymphonySnapshot {
	readonly selected: string | undefined;
	readonly messages: readonly SymphonyMessage[];
	readonly loading: boolean;
	readonly error: string | undefined;
}
export interface ISymphonyService {
	readonly state: IObservable<SymphonyViewState>;
	readonly available: boolean;
	watch(): IDisposable;
	refresh(): Promise<void>;
	select(id: string): void;
	configure(path: string): Promise<void>;
	submit(workflowId: string, title: string, prompt: string): Promise<void>;
	control(id: string, control: SymphonyControl): Promise<void>;
	enable(workflowId: string, enabled: boolean): Promise<void>;
}
export const ISymphonyService = createServiceIdentifier<ISymphonyService>('symphonyService');

/** Window-local presentation cache. Core owns messages/usage and Symphony owns scheduling. */
export class SymphonyService extends Disposable implements ISymphonyService {
	private readonly view = observableValue<SymphonyViewState>(this, { workflows: [], conversations: [], selected: undefined, messages: [], loading: false, error: undefined });
	public readonly state = this.view;
	public readonly available: boolean;
	private watchers = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private refreshing: Promise<void> | undefined;
	private commandError: string | undefined;
	private selectionGeneration = 0;
	private pollingGeneration = 0;
	private selected: string | undefined;

	constructor(@IRendererHostService private readonly host: IRendererHost, @IStorageService private readonly storage: IStorageService) {
		super();
		this.available = !!host.symphony;
		this.selected = storage.get('sessions.symphony.selected', StorageScope.WORKSPACE);
		if (host.symphony) { this._register(host.symphony.onDidChange(() => { if (this.watchers) { void this.refresh(); } })); }
		this._register(toDisposable(() => clearTimeout(this.timer)));
	}

	public watch(): IDisposable {
		if (++this.watchers === 1) { void this.poll(++this.pollingGeneration); }
		return toDisposable(() => { if (--this.watchers === 0) { this.pollingGeneration++; clearTimeout(this.timer); this.timer = undefined; } });
	}
	private async poll(generation: number): Promise<void> {
		await this.refresh();
		if (!this.isDisposed && this.watchers && this.available && generation === this.pollingGeneration) { this.timer = setTimeout(() => { void this.poll(generation); }, 1000); }
	}
	public refresh(): Promise<void> {
		if (this.refreshing) { return this.refreshing; }
		this.refreshing = this.read().finally(() => { this.refreshing = undefined; });
		return this.refreshing;
	}
	private async read(): Promise<void> {
		const backend = this.host.symphony;
		if (!backend) { this.view.set({ ...this.view.get(), error: localize('symphony.unavailable', 'Connect Ash to an App Server with Symphony support to schedule tasks.') }); return; }
		const generation = this.selectionGeneration;
		try {
			const snapshot = await backend.read();
			if (this.isDisposed || generation !== this.selectionGeneration) { return; }
			const selected = snapshot.conversations.some(item => item.id === this.selected) ? this.selected : snapshot.conversations[0]?.id;
			this.selected = selected;
			this.view.set({ ...this.view.get(), ...snapshot, selected, error: this.commandError });
			const feed = selected ? await backend.messages(selected) : undefined;
			if (this.isDisposed || generation !== this.selectionGeneration || selected !== this.selected) { return; }
			const conversations = feed ? snapshot.conversations.map(item => item.id === selected ? feed.conversation : item) : snapshot.conversations;
			this.view.set({ ...this.view.get(), conversations, messages: feed?.messages ?? [], error: this.commandError });
		} catch (error) { if (!this.isDisposed && generation === this.selectionGeneration) { this.view.set({ ...this.view.get(), error: String(error) }); } }
	}
	public select(id: string): void {
		if (this.selected === id) { return; }
		this.selected = id;
		this.selectionGeneration++;
		this.storage.store('sessions.symphony.selected', id, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.view.set({ ...this.view.get(), selected: id, messages: [] });
		void (this.refreshing ?? Promise.resolve()).then(() => this.refresh());
	}
	private async mutate(action: () => Promise<unknown>): Promise<void> {
		this.commandError = undefined;
		this.view.set({ ...this.view.get(), loading: true, error: undefined });
		try { await action(); await (this.refreshing ?? Promise.resolve()); await this.refresh(); }
		catch (error) { if (!this.isDisposed) { this.commandError = String(error); this.view.set({ ...this.view.get(), error: this.commandError }); } }
		finally { if (!this.isDisposed) { this.view.set({ ...this.view.get(), loading: false }); } }
	}
	public configure(path: string): Promise<void> { return this.mutate(() => this.host.symphony!.configure(path)); }
	public submit(workflowId: string, title: string, prompt: string): Promise<void> {
		return this.mutate(async () => { const conversation = await this.host.symphony!.submit(workflowId, title, prompt); this.select(conversation.id); });
	}
	public control(id: string, control: SymphonyControl): Promise<void> { return this.mutate(() => this.host.symphony!.control(id, control)); }
	public enable(workflowId: string, enabled: boolean): Promise<void> { return this.mutate(() => this.host.symphony!.enable(workflowId, enabled)); }
}
