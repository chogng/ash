import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableValue, observableFromEvent } from '../../../../base/common/observable.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { CanvasesEnabledSettingId } from '../../../../platform/agentHost/common/agentService.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { URI } from '../../../../base/common/uri.js';
import { CancellationError } from '../../../../base/common/errors.js';
import {
	IBrowserViewService,
	type IBrowserViewInfo,
	type BrowserViewEvent,
} from '../../../../platform/browserView/common/browserView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { BrowserViewModel } from '../../browserView/common/browserView.js';
import {
	CanvasInput,
	ICanvasContextService,
	type ICanvasService,
	type ICanvasReference,
	type ICanvasReopenTarget,
	type ICanvasModelResolution,
	type ICanvas,
} from '../common/canvas.js';
import { localize } from '../../../../nls.js';

interface LiveCanvas {
	readonly input: CanvasInput;
	readonly model: BrowserViewModel;
	readonly lifetime: DisposableStore;
	dismissed: boolean;
	requested: boolean;
	opening?: Promise<void>;
	lastRequestId?: string;
	lastRequestSucceeded?: boolean;
	dismissedRequestId?: string;
	suspended?: boolean;
	admitted?: boolean;
}

/** Projects Main-owned pages. Closing an editor never closes or serializes the native page. */
export class CanvasService extends Disposable implements ICanvasService {
	private readonly live = new Map<string, LiveCanvas>();
	readonly reopenableCanvases = observableValue<readonly ICanvasReopenTarget[]>(this, []);
	private readonly buffered: BrowserViewEvent[] = [];
	private initialized = false;
	private refreshScheduled = false;
	readonly enabled;
	private readonly restoreWaiters = new Set<() => void>();

	constructor(
		@IBrowserViewService private readonly pages: IBrowserViewService,
		@ICanvasContextService private readonly contexts: ICanvasContextService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IEditorService private readonly editors: IEditorService,
		@IEditorPart private readonly editorPart: IEditorPart,
		@INotificationService private readonly notifications: INotificationService,
		@IConfigurationService configuration: IConfigurationService,
	) {
		super();
		this.enabled = observableFromEvent(
			this,
			configuration.onDidChangeConfiguration,
			() =>
				configuration.getValue<boolean>(CanvasesEnabledSettingId) !== false &&
				configuration.getValue<boolean>(ChatAIDisabledSettingId) !== true,
		);
		this._register(
			autorun(reader => {
				this.enabled.read(reader);
				for (const context of contexts.contexts.read(reader)) {
					context.canvases.read(reader);
					context.openRequests?.read(reader);
				}
				const state = contexts.workingSets?.state.read(reader);
				if (state?.applying) {
					for (const entry of this.live.values()) {
						if (entry.opening || this.editorPart.groups.some(group => group.inputs.includes(entry.input))) {
							entry.suspended = true;
						}
					}
				}
				if (!state?.restoring) {
					for (const resolve of this.restoreWaiters) {
						resolve();
					}
					this.restoreWaiters.clear();
				}
				this.scheduleRefresh();
			}),
		);
		this._register(
			contexts.onDidRemoveOwner(owner => {
				for (const entry of this.live.values()) {
					if (
						entry.input.reference.providerId === owner.providerId &&
						entry.input.reference.session.toString() === owner.session.toString() &&
						entry.input.reference.chat.toString() === owner.chat.toString()
					) {
						this.acceptEvent({ type: 'closed', targetId: entry.model.id });
					}
				}
			}),
		);
		this._register(
			pages.onDidEvent(event => {
				if (!this.initialized) {
					this.buffered.push(event);
				} else {
					this.acceptEvent(event);
				}
			}),
		);
		this._register(contexts.onDidChangeVisibility(() => this.scheduleRefresh()));
		this._register(
			editorPart.onDidChangeEditors(event => {
				if (
					event.kind !== 'groupChanged' ||
					event.event.kind !== 'editorClosed' ||
					event.event.reason === 'move' ||
					event.event.reason === 'reset'
				) {
					return;
				}
				for (const entry of this.live.values()) {
					if (entry.input === event.event.editor.input) {
						entry.dismissed = true;
						entry.requested = false;
						const instanceId = entry.input.canvas.get().instanceId;
						entry.dismissedRequestId = instanceId
							? this.contexts.getContext(entry.input.reference)?.openRequests?.get().get(instanceId)?.id
							: undefined;
					}
				}
				this.scheduleRefresh();
			}),
		);
		this._register(
			toDisposable(() => {
				for (const resolve of this.restoreWaiters) {
					resolve();
				}
				this.restoreWaiters.clear();
				for (const entry of this.live.values()) {
					entry.lifetime.dispose();
				}
				this.live.clear();
			}),
		);
		void this.initialize().catch(error => {
			if (this.isDisposed) {
				return;
			}
			this.initialized = true;
			for (const event of this.buffered.splice(0)) {
				this.acceptEvent(event);
			}
			this.notifications.error(
				localize('canvas.initializeFailed', 'Could not load conversation Canvases: {0}', String(error)),
			);
		});
	}

	private async initialize(): Promise<void> {
		const snapshot = await this.pages.getBrowserViews();
		if (this.isDisposed) {
			return;
		}
		for (const page of snapshot) {
			this.acceptInfo(page, true);
		}
		for (const event of this.buffered.splice(0)) {
			this.acceptEvent(event);
		}
		this.initialized = true;
		this.refresh();
	}

	private acceptInfo(info: IBrowserViewInfo, requested: boolean): void {
		if (!info.canvas) {
			return;
		}
		const resource = URI.from({ scheme: 'agent-host-canvas', path: '/' + info.id });
		const thread = info.owner.type === 'agent' ? info.owner.sessionId : info.canvas.threadId;
		if (!thread) {
			return;
		}
		const chat = URI.from({ scheme: 'ash-thread', path: '/' + thread });
		const session = URI.from({ scheme: 'ash-session', path: '/' + info.canvas.sessionId });
		const canvas: ICanvas = {
			resource,
			instanceId: info.canvas.instanceId,
			title: info.canvas.title,
			source: info.state.url === 'about:blank' || info.canvas.extensionId ? undefined : URI.parse(info.state.url),
		};
		if (
			this.contexts
				.getContext({ providerId: 'local-agent-host', session, chat })
				?.openRequests?.get()
				.has(info.canvas.instanceId)
		) {
			requested = false;
		}
		let entry = this.live.get(info.id);
		if (!entry) {
			const lifetime = new DisposableStore();
			const input = lifetime.add(
				this.instantiation.createInstance(
					CanvasInput,
					{ providerId: 'local-agent-host', session, chat, canvas: resource },
					canvas,
				),
			);
			const model = lifetime.add(this.instantiation.createInstance(BrowserViewModel, info));
			entry = { input, model, lifetime, dismissed: false, requested };
			if (this.contexts.workingSets) {
				lifetime.add(this.contexts.workingSets.registerEditorToRetain(input));
			}
			this.live.set(info.id, entry);
		} else {
			entry.input.setCanvas(canvas);
			if (requested) {
				entry.dismissed = false;
				entry.requested = true;
			}
		}
	}

	private acceptEvent(event: BrowserViewEvent): void {
		if (event.type === 'created' || event.type === 'canvasOpened') {
			if (!event.info.canvas) {
				return;
			}
			this.acceptInfo(event.info, event.type === 'canvasOpened');
		} else if (event.type === 'stateChanged') {
			const entry = this.live.get(event.state.targetId);
			if (!entry) {
				return;
			}
			if (!entry.model.info.canvas?.extensionId) {
				entry.input.setCanvas({
					...entry.input.canvas.get(),
					source: event.state.url === 'about:blank' ? undefined : URI.parse(event.state.url),
				});
			}
		} else if (event.type === 'closed') {
			const entry = this.live.get(event.targetId);
			if (entry) {
				this.live.delete(event.targetId);
				void this.closeEditors(entry.input)
					.catch(error => this.notifications.error(error))
					.finally(() => entry.lifetime.dispose());
			}
		} else {
			return;
		}
		if (this.initialized) {
			this.scheduleRefresh();
		}
	}

	private scheduleRefresh(): void {
		if (this.refreshScheduled) {
			return;
		}
		this.refreshScheduled = true;
		// Finish broadcasting Main's snapshot to the page models before resolving an editor input.
		queueMicrotask(() => {
			this.refreshScheduled = false;
			if (!this.isDisposed) {
				this.refresh();
			}
		});
	}

	private refresh(): void {
		if (!this.initialized || this.isDisposed) {
			return;
		}
		const targets: ICanvasReopenTarget[] = [];
		for (const entry of this.live.values()) {
			const context = this.contexts.getContext(entry.input.reference);
			const canvas = context?.canvases
				.get()
				?.find(canvas => canvas.resource.toString() === entry.input.reference.canvas.toString());
			if (canvas) {
				entry.input.setCanvas(canvas);
			}
			const request = canvas?.instanceId ? context?.openRequests?.get().get(canvas.instanceId) : undefined;
			const isOpen = this.editorPart.groups.some(group => group.inputs.includes(entry.input));
			if (request && (request.id !== entry.lastRequestId || (request.succeeded && !entry.lastRequestSucceeded))) {
				entry.lastRequestId = request.id;
				entry.lastRequestSucceeded = request.succeeded;
				if (request.succeeded && request.id !== entry.dismissedRequestId) {
					entry.dismissed = false;
					entry.requested = !isOpen;
				}
			}
			if (!this.enabled.get()) {
				if (isOpen && !entry.dismissed) {
					entry.suspended = true;
				}
				void this.closeEditors(entry.input).catch(error => this.notifications.error(error));
				continue;
			}
			if (!this.contexts.isOwnerVisible(entry.input.reference)) {
				continue;
			}
			if (!entry.input.canvas.get().source) {
				continue;
			}
			if (!isOpen && !entry.opening && entry.dismissed) {
				targets.push({ reference: entry.input.reference, canvas: entry.input.canvas.get() });
			}
			if (this.contexts.workingSets?.state.get().restoring) {
				continue;
			}
			if (entry.requested && !entry.dismissed) {
				entry.requested = false;
				if (isOpen) {
					continue;
				}
				void this.revealCanvas(entry.input.reference).catch(error => {
					if (!(error instanceof CancellationError)) {
						this.notifications.error(
							localize('canvas.openFailed', 'Could not open Canvas: {0}', String(error)),
						);
					}
				});
			} else if (
				entry.suspended &&
				!entry.dismissed &&
				!this.editorPart.groups.some(group => group.inputs.includes(entry.input))
			) {
				entry.suspended = false;
				void this.openInput(entry, true).catch(error => {
					if (!(error instanceof CancellationError)) {
						this.notifications.error(error);
					}
				});
			}
		}
		this.reopenableCanvases.set(targets, undefined);
	}

	isOwnerPresentable(reference: ICanvasReference): boolean {
		return (
			!this.isDisposed &&
			this.enabled.get() &&
			this.contexts.isOwnerVisible(reference) &&
			!!this.lookup(reference)
		);
	}

	async revealCanvas(reference: ICanvasReference): Promise<void> {
		if (this.contexts.workingSets?.state.get().restoring) {
			await new Promise<void>(resolve => this.restoreWaiters.add(resolve));
		}
		const entry = this.lookup(reference);
		if (!entry || !this.isOwnerPresentable(reference)) {
			throw new CancellationError();
		}
		entry.dismissed = false;
		if (!entry.input.canvas.get().source) {
			entry.requested = true;
			return;
		}
		return this.openInput(entry, false);
	}

	private async openInput(entry: LiveCanvas, restore: boolean): Promise<void> {
		const reference = entry.input.reference;
		entry.opening ??= (async () => {
			const suppression = restore ? this.contexts.workingSets?.suppressEditorPartAutoVisibility() : undefined;
			try {
				const group = this.contexts.getEditorGroup(reference, entry.input, restore);
				await this.editors.openEditor(
					entry.input,
					{ pinned: true, ignoreError: true, preserveFocus: restore },
					group ? { groupId: group.id } : undefined,
				);
			} catch (error) {
				entry.dismissed = true;
				if (!this.live.has(entry.model.id) || this.isDisposed) {
					throw new CancellationError();
				}
				throw error;
			} finally {
				suppression?.dispose();
			}
			if (!this.live.has(entry.model.id) || entry.dismissed || !this.contexts.isOwnerVisible(reference)) {
				await this.closeEditors(entry.input);
			}
		})().finally(() => {
			entry.opening = undefined;
			this.scheduleRefresh();
		});
		await entry.opening;
	}

	reopenCanvas(reference: ICanvasReference): Promise<void> {
		return this.revealCanvas(reference);
	}

	async closeCanvas(reference: ICanvasReference): Promise<void> {
		const entry = this.lookup(reference);
		if (!entry || !this.isOwnerPresentable(reference)) {
			throw new CancellationError();
		}
		const context = this.contexts.getContext(reference);
		if (context?.closeCanvas) {
			await context.closeCanvas(entry.input.canvas.get());
		} else {
			await this.pages.destroyBrowserView(entry.model.id);
		}
	}

	restoreCanvasInput(serializationId: string): CanvasInput | undefined {
		return [...this.live.values()].find(entry => entry.admitted && entry.input.serializationId === serializationId)
			?.input;
	}

	async resolveCanvasModel(reference: ICanvasReference, source: URI): Promise<ICanvasModelResolution> {
		const entry = this.lookup(reference);
		if (
			!entry ||
			!this.isOwnerPresentable(reference) ||
			entry.input.canvas.get().source?.toString() !== source.toString()
		) {
			throw new CancellationError();
		}
		entry.admitted = true;
		return { model: entry.model, reused: true };
	}

	private lookup(reference: ICanvasReference): LiveCanvas | undefined {
		const entry = this.live.get(reference.canvas.path.slice(1));
		return entry &&
			entry.input.reference.providerId === reference.providerId &&
			entry.input.reference.chat.toString() === reference.chat.toString() &&
			entry.input.reference.session.toString() === reference.session.toString()
			? entry
			: undefined;
	}

	private async closeEditors(input: CanvasInput): Promise<void> {
		await Promise.all(
			this.editorPart.groups
				.filter(group => group.inputs.includes(input))
				.map(group => group.closeEditor(input, { reason: 'reset' })),
		);
	}
}
