import { Disposable, DisposableMap } from '../../../base/common/lifecycle.js';
import { isRecord } from '../../../base/common/types.js';
import type { Event } from '../../../base/common/event.js';
import type { IBrowserViewGroupFilter, IBrowserViewGroupService } from '../common/browserViewGroup.js';
import type { CDPEvent, CDPRequest, CDPResponse } from '../common/cdp/types.js';
import { IBrowserViewMainService } from './browserViewMainService.js';
import { BrowserViewGroup } from './browserViewGroup.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';

/** The connection's window scope is selected by product assembly, never by a CDP request. */
export class BrowserViewGroupMainService extends Disposable implements IBrowserViewGroupService {
	private readonly groups = this._register(new DisposableMap<string, BrowserViewGroup>());
	constructor(@IBrowserViewMainService private readonly views: IBrowserViewMainService,
		@IInstantiationService private readonly instantiationService: IInstantiationService) { super(); }
	public async createGroup(filter: IBrowserViewGroupFilter): Promise<string> {
		this.assertNotDisposed();
		if (!isRecord(filter) || typeof filter.sandboxSessionId !== 'string' || filter.sandboxSessionId.length === 0
			|| (filter.browserIds !== undefined && (!Array.isArray(filter.browserIds) || !filter.browserIds.every(id => typeof id === 'string')))) {
			throw new TypeError('Invalid browser group filter');
		}
		for (const id of filter.browserIds ?? []) { this.views.validateAgentAccess(id, filter.sandboxSessionId); }
		const group = this.instantiationService.createInstance(BrowserViewGroup, filter, (id: string) => { this.groups.deleteAndLeak(id); });
		this.groups.set(group.id, group);
		try { await group.initialize(); return group.id; }
		catch (error) { this.groups.deleteAndDispose(group.id); throw error; }
	}
	public async destroyGroup(id: string): Promise<void> { this.group(id); this.groups.deleteAndDispose(id); }
	public onDynamicDidDestroy(id: string): Event<void> { return this.group(id).onDidDestroy; }
	public onDynamicCDPMessage(id: string): Event<CDPEvent | CDPResponse> { return this.group(id).onCDPMessage; }
	public sendCDPMessage(id: string, message: CDPRequest): Promise<void> {
		if (!isRecord(message) || !Number.isSafeInteger(message.id) || message.id < 0 || typeof message.method !== 'string'
			|| (message.sessionId !== undefined && typeof message.sessionId !== 'string')) { throw new TypeError('Invalid CDP request'); }
		return this.group(id).sendCDPMessage(message);
	}
	private group(id: string): BrowserViewGroup {
		this.assertNotDisposed();
		const group = this.groups.get(id);
		if (!group) { throw new Error('BrowserGroupUnavailable'); }
		return group;
	}
}
