import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isRecord } from '../../../../base/common/types.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import {
	CDPError, CDPInvalidParamsError, CDPMethodNotFoundError,
	type CDPEvent, type CDPRequest, type CDPResponse, type CDPTargetInfo, type ICDPBrowserHost,
} from './types.js';

type Session =
	| { type: 'browser'; parent?: string; }
	| { type: 'page'; targetId: string; parent?: string; actual?: string; childTargetId?: string; childTargetInfo?: CDPTargetInfo; autoAttach: boolean; automatic: boolean; };

/** Handles one logical browser connection without owning its host's pages or Chromium attachment. */
export class CDPBrowserProxy extends Disposable {
	private readonly messages = this._register(new Emitter<CDPEvent | CDPResponse>());
	public readonly onMessage = this.messages.event;
	private readonly sessions = new Map<string, Session>();
	private readonly discover = new Set<string | undefined>();
	private readonly autoAttach = new Set<string | undefined>();

	constructor(private readonly host: ICDPBrowserHost) {
		super();
		this._register(host.onTargetEvent(event => {
			switch (event.type) {
				case 'created':
				case 'changed':
					for (const parent of this.discover) {
						this.event(event.type === 'created' ? 'Target.targetCreated' : 'Target.targetInfoChanged', { targetInfo: this.info(event.targetInfo) }, parent);
					}
					if (event.type === 'created') {
						for (const parent of this.autoAttach) { this.attach(event.targetInfo.targetId, parent, true); }
					}
					break;
				case 'destroyed':
					for (const [id, session] of [...this.sessions]) {
						if (session.type === 'page' && session.targetId === event.targetId && this.sessions.has(id)) { this.detach(id); }
					}
					for (const parent of this.discover) { this.event('Target.targetDestroyed', { targetId: event.targetId }, parent); }
					break;
				case 'message': this.forward(event.targetId, event.message); break;
			}
		}));
	}

	private info(target: CDPTargetInfo): CDPTargetInfo {
		const attached = [...this.sessions.values()].some(session => session.type === 'page' && (session.targetId === target.targetId || session.childTargetId === target.targetId));
		return { ...target, attached };
	}

	private attach(targetId: string, parent?: string, automatic = false): string {
		const child = [...this.sessions.values()].find(session => session.type === 'page' && session.childTargetId === targetId);
		const target = child?.type === 'page' && child.childTargetInfo ? child.childTargetInfo : this.host.getTargetInfo(targetId);
		const sessionId = generateUuid();
		this.sessions.set(sessionId, child?.type === 'page'
			? { ...child, parent, autoAttach: false, automatic }
			: { type: 'page', targetId: target.targetId, parent, autoAttach: false, automatic });
		this.event('Target.attachedToTarget', { sessionId, targetInfo: this.info(target), waitingForDebugger: false }, parent);
		return sessionId;
	}

	private detach(id: string): void {
		const session = this.sessions.get(id);
		if (!session) { throw new Error('BrowserCDPSessionUnavailable'); }
		this.sessions.delete(id);
		this.discover.delete(id);
		this.autoAttach.delete(id);
		// Recursing over both browser and page children retires only this session's subscriptions.
		for (const [childId, child] of [...this.sessions]) {
			if (child.parent === id && this.sessions.has(childId)) { this.detach(childId); }
		}
		if (session.type === 'page') {
			this.event('Target.detachedFromTarget', { sessionId: id, targetId: session.childTargetId ?? session.targetId }, session.parent);
		}
	}

	private event(method: string, params: unknown, sessionId?: string): void {
		if (!this.isDisposed) { this.messages.fire({ method, params, ...(sessionId ? { sessionId } : {}) }); }
	}

	private forward(targetId: string, event: CDPEvent): void {
		for (const [id, session] of [...this.sessions]) {
			if (session.type !== 'page' || session.targetId !== targetId || session.actual !== event.sessionId) { continue; }
			if (event.method === 'Target.attachedToTarget' && isRecord(event.params)) {
				if (!session.autoAttach || typeof event.params.sessionId !== 'string' || !isRecord(event.params.targetInfo) || typeof event.params.targetInfo.targetId !== 'string') { continue; }
				// Route commands through the owning page, but retire the actual child target.
				const childId = generateUuid();
				this.sessions.set(childId, { type: 'page', targetId, parent: id, actual: event.params.sessionId, childTargetId: event.params.targetInfo.targetId, childTargetInfo: event.params.targetInfo as unknown as CDPTargetInfo, autoAttach: false, automatic: false });
				this.event(event.method, { ...event.params, sessionId: childId }, id);
			} else if (event.method === 'Target.detachedFromTarget' && isRecord(event.params)) {
				for (const [childId, child] of [...this.sessions]) {
					if (child.type === 'page' && child.targetId === targetId && child.actual === event.params.sessionId) { this.detach(childId); }
				}
			} else { this.event(event.method, event.params, id); }
		}
	}

	public async sendMessage(message: CDPRequest): Promise<void> {
		this.assertNotDisposed();
		const session = message.sessionId ? { sessionId: message.sessionId } : {};
		try {
			const result = await this.sendCommand(message.method, message.params, message.sessionId);
			if (!this.isDisposed) { this.messages.fire({ id: message.id, result, ...session }); }
		} catch (error) {
			if (!this.isDisposed) {
				this.messages.fire({
					id: message.id,
					error: {
						code: error instanceof CDPError ? error.code : -32000,
						message: error instanceof Error ? error.message : String(error),
					},
					...session,
				});
			}
		}
	}

	public async sendCommand(method: string, params: unknown = {}, sessionId?: string): Promise<unknown> {
		this.assertNotDisposed();
		await this.host.whenReady();
		this.assertNotDisposed();
		if (!isRecord(params)) { throw new CDPInvalidParamsError('Invalid CDP parameters'); }
		const parent = sessionId || undefined;
		const session = parent ? this.sessions.get(parent) : undefined;
		if (parent && !session) { throw new Error('BrowserCDPSessionUnavailable'); }
		const browser = !session || session.type === 'browser';
		if (method === 'Browser.getVersion') { return this.host.getVersion(); }
		if (method === 'Target.getTargetInfo') {
			const targetId = params.targetId ?? (session?.type === 'page' ? session.childTargetId ?? session.targetId : undefined);
			const child = [...this.sessions.values()].find(value => value.type === 'page' && value.childTargetId === targetId);
			const targetInfo = targetId === undefined
				? this.host.targetInfo
				: this.info(child?.type === 'page' && child.childTargetInfo ? child.childTargetInfo : this.host.getTargetInfo(stringParam(targetId, 'targetId')));
			return { targetInfo };
		}
		if (method === 'Browser.getWindowForTarget') {
			return this.host.getWindowForTarget(stringParam(params.targetId ?? (session?.type === 'page' ? session.targetId : undefined), 'targetId'));
		}
		if (browser || (method.startsWith('Target.') && method !== 'Target.setAutoAttach')) {
			switch (method) {
				case 'Target.getTargets': return { targetInfos: this.host.getTargets().map(target => this.info(target)) };
				case 'Target.getBrowserContexts': return { browserContextIds: this.host.getBrowserContexts() };
				case 'Target.setDiscoverTargets':
					if (booleanParam(params.discover, 'discover')) {
						this.discover.add(parent);
						for (const target of this.host.getTargets()) { this.event('Target.targetCreated', { targetInfo: this.info(target) }, parent); }
					} else { this.discover.delete(parent); }
					return {};
				case 'Target.setAutoAttach':
					if (params.flatten !== true) { throw new CDPInvalidParamsError('CDP requires flattened sessions'); }
					if (booleanParam(params.autoAttach, 'autoAttach')) {
						this.autoAttach.add(parent);
						for (const target of this.host.getTargets()) {
							const attached = [...this.sessions.values()].some(value =>
								value.type === 'page' && value.targetId === target.targetId && value.parent === parent && value.automatic);
							if (!attached) { this.attach(target.targetId, parent, true); }
						}
					} else {
						this.autoAttach.delete(parent);
						for (const [id, value] of [...this.sessions]) {
							if (value.type === 'page' && value.parent === parent && value.automatic && this.sessions.has(id)) { this.detach(id); }
						}
					}
					return {};
				case 'Target.attachToBrowserTarget': {
					const id = generateUuid();
					this.sessions.set(id, { type: 'browser', parent });
					return { sessionId: id };
				}
				case 'Target.attachToTarget':
					if (params.flatten !== true) { throw new CDPInvalidParamsError('CDP requires flattened sessions'); }
					return { sessionId: this.attach(stringParam(params.targetId, 'targetId'), parent) };
				case 'Target.detachFromTarget':
					this.detach(stringParam(params.sessionId, 'sessionId'));
					return {};
				case 'Target.closeTarget':
					await this.host.closeTarget(stringParam(params.targetId, 'targetId'));
					return { success: true };
				case 'Target.activateTarget':
					this.host.activateTarget(stringParam(params.targetId, 'targetId'));
					return {};
				case 'Target.createTarget': {
					const contextId = params.browserContextId === undefined ? undefined : stringParam(params.browserContextId, 'browserContextId');
					const target = await this.host.createTarget(stringParam(params.url, 'url'), contextId);
					return { targetId: target.targetId };
				}
				default: throw new CDPMethodNotFoundError(method);
			}
		}
		if (session.type !== 'page' || method.startsWith('Browser.')) { throw new Error('BrowserCDPAccessDenied'); }
		if (method === 'Target.setAutoAttach') { session.autoAttach = booleanParam(params.autoAttach, 'autoAttach'); }
		// Child commands use Chromium's session ID; clients see only this connection's IDs.
		return this.host.sendCommand(session.targetId, method, params, session.actual);
	}

	protected override disposeCore(): void {
		this.sessions.clear();
		this.discover.clear();
		this.autoAttach.clear();
		super.disposeCore();
	}
}

function stringParam(value: unknown, name: string): string {
	if (typeof value !== 'string') { throw new CDPInvalidParamsError('Invalid CDP parameter: ' + name); }
	return value;
}

function booleanParam(value: unknown, name: string): boolean {
	if (typeof value !== 'boolean') { throw new CDPInvalidParamsError('Invalid CDP parameter: ' + name); }
	return value;
}
