import { status } from '../../../../base/browser/ui/aria/aria.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { Event } from '../../../../base/common/event.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, derived, observableFromEvent, observableValue, transaction, type IReader } from '../../../../base/common/observable.js';
import { isRecord } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { CanvasesEnabledSettingId } from '../../../../platform/agentHost/common/agentService.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IAgentHostCanvasCollection } from '../../../../workbench/contrib/canvases/common/agentHostCanvas.js';
import { getCanvasReferenceKey, type ICanvas, type ICanvasReference } from '../../../../workbench/contrib/canvases/common/canvas.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { IPinnedCanvasService, MAX_PINNED_CANVASES, PINNED_CANVAS_PAGE_ID, PinnedCanvasState, type IPinnedCanvas, type IPinnedCanvasIdentity, type PinnedCanvasTarget } from './pinnedCanvases.js';

const storageKey = 'sessions.pinnedCanvases';

class Pin implements IPinnedCanvas {
	readonly id: string;
	readonly canvas = observableValue<ICanvas | undefined>(this, undefined);
	readonly reference = derived<ICanvasReference | undefined>(reader => {
		const canvas = this.canvas.read(reader);
		return canvas ? { providerId: this.identity.providerId, session: this.identity.session, chat: this.identity.chat, canvas: canvas.resource } : undefined;
	});
	readonly title;
	readonly chatTitle = observableValue<string | undefined>(this, undefined);
	readonly state = observableValue(this, PinnedCanvasState.Pending);
	readonly reconnecting = observableValue(this, false);
	wasLive = false;
	wasInCatalog = false;

	constructor(readonly identity: IPinnedCanvasIdentity, title: string) {
		const hash = new StringSHA1();
		hash.update(JSON.stringify([identity.providerId, identity.session.toString(), identity.chat.toString(), identity.extensionId, identity.canvasId, identity.instanceId]));
		this.id = hash.digest();
		this.title = observableValue(this, title);
	}
}

/** Owns profile-local pin identities. Membership and page state remain with the host collection. */
export class PinnedCanvasService extends Disposable implements IPinnedCanvasService {
	private readonly pins = observableValue<readonly Pin[]>(this, []);
	readonly enabled;
	readonly entries;
	readonly selected;

	constructor(
		@IAgentHostCanvasCollection private readonly collection: IAgentHostCanvasCollection,
		@ISessionsManagementService management: ISessionsManagementService,
		@ISessionsService private readonly sessions: ISessionsService,
		@ISessionsProvidersService providers: ISessionsProvidersService,
		@ICustomViewService private readonly views: ICustomViewService,
		@IConfigurationService configuration: IConfigurationService,
		@IStorageService private readonly storage: IStorageService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.enabled = observableFromEvent(this, configuration.onDidChangeConfiguration,
			() => configuration.getValue<boolean>(CanvasesEnabledSettingId) !== false && configuration.getValue<boolean>(ChatAIDisabledSettingId) !== true);
		this.entries = derived<readonly IPinnedCanvas[]>(reader => this.enabled.read(reader) ? this.pins.read(reader) : []);
		this.selected = derived(reader => {
			const opening = views.activeCustomViewOpen.read(reader);
			return opening?.descriptor.id === PINNED_CANVAS_PAGE_ID ? this.entries.read(reader).find(pin => pin.id === opening.state) : undefined;
		});
		try {
			const raw = storage.get(storageKey, StorageScope.PROFILE);
			if (raw !== undefined) { this.pins.set(this.restore(JSON.parse(raw))); }
		} catch (error) {
			notifications.error(localize('pinnedCanvas.invalidStorage', 'Could not restore pinned Canvases: {0}', String(error)));
		}
		const catalog = observableFromEvent(this, Event.any(management.onDidChange, providers.onDidChangeProviders), () => management.sessions);
		this._register(autorun(reader => {
			const sessions = catalog.read(reader);
			const enabled = this.enabled.read(reader);
			const removed = new Set<Pin>();
			if (!enabled && views.activeCustomView.get()?.id === PINNED_CANVAS_PAGE_ID) { views.hideCustomView(); }
			for (const pin of this.pins.read(reader)) {
				const session = sessions.find(session => session.sessionId === pin.identity.session.path.slice(1) && (session.providerId ?? 'local-agent-host') === pin.identity.providerId);
				const provider = providers.getProvider(pin.identity.providerId);
				const connected = !!provider && (provider.connectionStatus?.read(reader) ?? 'connected') === 'connected';
				if (!connected) { pin.wasLive = false; }
				const deleted = pin.wasInCatalog && !session && management.state === 'ready' && connected;
				if (session) { pin.wasInCatalog = true; }
				const chat = session?.chats.find(chat => chat.threadId === pin.identity.chat.path.slice(1));
				if (deleted || session?.status === 'archived' || chat?.status === 'archived' || session?.agentTree !== undefined && !chat) {
					removed.add(pin);
					continue;
				}
				pin.chatTitle.set(chat?.title ?? session?.title);
				const canvases = enabled && connected ? collection.createContext(pin.identity).canvases.read(reader) : undefined;
				const canvas = canvases?.find(canvas => canvas.instanceId === pin.identity.instanceId
					&& canvas.extensionId === pin.identity.extensionId && canvas.canvasId === pin.identity.canvasId);
				if (enabled && pin.wasLive && canvases !== undefined && !canvas) { removed.add(pin); continue; }
				transaction(tx => {
					pin.canvas.set(canvas, tx);
					pin.state.set(!enabled || canvases === undefined ? PinnedCanvasState.Pending : canvas ? PinnedCanvasState.Live : PinnedCanvasState.Unavailable, tx);
					pin.reconnecting.set(enabled && canvases === undefined, tx);
					if (canvas) { pin.title.set(canvas.title, tx); pin.wasLive = true; }
				});
			}
			if (removed.size) {
				const selected = this.selected.get();
				this.pins.set(this.pins.get().filter(pin => !removed.has(pin)));
				if (selected && removed.has(selected as Pin)) { views.hideCustomView(); }
			}
			this.save();
		}));
	}

	private restore(value: unknown): readonly Pin[] {
		if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.pins) || value.pins.length > MAX_PINNED_CANVASES
			|| Object.keys(value).some(key => !['version', 'pins'].includes(key))) { throw new TypeError('Invalid pinned Canvas state'); }
		const pins = value.pins.map(value => {
			if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'canvasId,chat,extensionId,instanceId,providerId,session,title'
				|| Object.values(value).some(value => typeof value !== 'string' || !value || value.length > 4096)) { throw new TypeError('Invalid pinned Canvas identity'); }
			const session = URI.parse(value.session as string);
			const chat = URI.parse(value.chat as string);
			if (session.scheme !== 'ash-session' || chat.scheme !== 'ash-thread' || [session, chat].some(uri => !uri.path.startsWith('/') || uri.path.length < 2 || !!uri.authority || !!uri.query || !!uri.fragment) || !/^[A-Za-z0-9._-]{1,128}$/.test(value.instanceId as string)) { throw new TypeError('Invalid pinned Canvas owner'); }
			return new Pin({ providerId: value.providerId as string, session, chat, extensionId: value.extensionId as string, canvasId: value.canvasId as string, instanceId: value.instanceId as string }, value.title as string);
		});
		if (new Set(pins.map(pin => pin.id)).size !== pins.length) { throw new TypeError('Duplicate pinned Canvas identity'); }
		return pins;
	}

	private save(): void {
		this.storage.store(storageKey, JSON.stringify({
			version: 1, pins: this.pins.get().map(pin => ({
				...pin.identity, session: pin.identity.session.toString(), chat: pin.identity.chat.toString(), title: pin.title.get(),
			}))
		}), StorageScope.PROFILE, StorageTarget.USER);
	}

	getEntry(target: PinnedCanvasTarget, reader?: IReader): IPinnedCanvas | undefined {
		if (this.isDisposed) { return undefined; }
		return this.entries.read(reader).find(pin => 'identity' in target ? pin.id === target.id
			: pin.reference.read(reader) && getCanvasReferenceKey(pin.reference.read(reader)!) === getCanvasReferenceKey(target));
	}
	isPinned(reference: ICanvasReference, reader?: IReader): boolean { return !!this.getEntry(reference, reader); }
	isShown(reference: ICanvasReference, reader?: IReader): boolean {
		const pin = this.selected.read(reader);
		return !!pin && pin === this.getEntry(reference, reader);
	}
	getTrackedCanvas(reference: ICanvasReference, reader?: IReader): ICanvas | undefined { return this.getEntry(reference, reader)?.canvas.read(reader); }

	pin(reference: ICanvasReference): boolean {
		if (this.isDisposed || !this.enabled.get()) { return false; }
		if (this.isPinned(reference)) { return true; }
		const canvas = this.collection.createContext(reference).canvases.get()?.find(canvas => canvas.resource.toString() === reference.canvas.toString());
		if (!canvas?.instanceId || !canvas.extensionId || !canvas.canvasId) {
			this.notifications.warn(localize('pinnedCanvas.requiresIdentity', 'Only a registered extension Canvas can be pinned to the sidebar.'));
			return false;
		}
		if (this.pins.get().length >= MAX_PINNED_CANVASES) {
			this.notifications.warn(localize('pinnedCanvas.limit', 'You can pin up to {0} Canvases to the sidebar.', MAX_PINNED_CANVASES));
			return false;
		}
		const pin = new Pin({
			providerId: reference.providerId, session: reference.session, chat: reference.chat,
			extensionId: canvas.extensionId, canvasId: canvas.canvasId, instanceId: canvas.instanceId
		}, canvas.title);
		this.pins.set([...this.pins.get(), pin]);
		status(localize('pinnedCanvas.added', 'Added Canvas {0} to the sidebar.', canvas.title));
		return true;
	}

	unpin(target: PinnedCanvasTarget): void {
		const pin = this.getEntry(target);
		if (!pin) { return; }
		if (this.selected.get() === pin) { this.views.hideCustomView(); }
		this.pins.set(this.pins.get().filter(candidate => candidate !== pin));
		status(localize('pinnedCanvas.removed', 'Removed Canvas {0} from the sidebar.', pin.title.get()));
	}
	async show(target: PinnedCanvasTarget): Promise<void> {
		const pin = this.getEntry(target);
		if (pin) { this.views.showCustomView(PINNED_CANVAS_PAGE_ID, { state: pin.id }); }
	}
	async reconnect(target: PinnedCanvasTarget): Promise<void> {
		const pin = this.getEntry(target);
		if (!pin) { return; }
		const provider = this.collection.createContext(pin.identity).definitionProvider;
		const definitions = await provider?.listCanvases();
		if (this.getEntry(pin) !== pin) { return; }
		const definition = definitions?.find(definition => definition.extensionId === pin.identity.extensionId && definition.canvasId === pin.identity.canvasId);
		if (definition) { await provider!.openCanvas(definition, pin.identity.instanceId); }
	}
	async goToChat(target: PinnedCanvasTarget): Promise<void> {
		const pin = this.getEntry(target);
		if (!pin) { return; }
		await this.sessions.openThread(pin.identity.session.path.slice(1), pin.identity.chat.path.slice(1));
	}
	async closeCanvas(target: PinnedCanvasTarget): Promise<void> {
		const pin = this.getEntry(target);
		const canvas = pin?.canvas.get();
		if (pin && canvas) {
			await this.collection.createContext(pin.identity).closeCanvas?.(canvas);
			// A delayed close may finish after this pin has rebound to a new lifetime.
			if (this.getEntry(pin) === pin && pin.canvas.get()?.resource.toString() === canvas.resource.toString()) { this.unpin(pin); }
		}
	}
}
