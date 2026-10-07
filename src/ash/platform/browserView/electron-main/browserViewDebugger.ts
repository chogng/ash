import type { WebContents } from 'electron/main';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import type { CDPEvent } from '../common/cdp/types.js';
import { isRecord } from '../../../base/common/types.js';

/** One page owns the Chromium attachment; groups borrow it independently. */
export class BrowserViewDebugger extends Disposable {
	private readonly events = this._register(new Emitter<CDPEvent>());
	public readonly onEvent = this.events.event;
	private leases = 0;
	private attachedHere = false;
	private readonly pending = new Set<Promise<unknown>>();
	constructor(private readonly contents: WebContents) {
		super();
		const message = (_event: unknown, method: string, params: unknown, sessionId: string): void => {
			this.events.fire({ method, params, ...(sessionId ? { sessionId } : {}) });
		};
		contents.debugger.on('message', message);
		this._register(toDisposable(() => contents.debugger.off('message', message)));
	}
	public acquire(): IDisposable {
		this.assertNotDisposed();
		if (this.leases === 0) {
			this.attachedHere = !this.contents.debugger.isAttached();
			if (this.attachedHere) { this.contents.debugger.attach('1.3'); }
		}
		this.leases++;
		return toDisposable(() => {
			if (--this.leases === 0 && !this.isDisposed && this.attachedHere && this.contents.debugger.isAttached()) { this.contents.debugger.detach(); }
		});
	}
	public sendCommand(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
		this.assertNotDisposed();
		const command = this.contents.debugger.sendCommand(method, params, sessionId);
		this.pending.add(command);
		void command.then(() => this.pending.delete(command), () => this.pending.delete(command));
		return command;
	}
	public async whenIdle(): Promise<void> {
		while (this.pending.size > 0) { await Promise.allSettled(this.pending); }
	}
	public async getTargetId(): Promise<string> {
		const result = await this.sendCommand('Target.getTargetInfo');
		if (!isRecord(result) || !isRecord(result.targetInfo) || typeof result.targetInfo.targetId !== 'string') { throw new Error('BrowserCDPTargetUnavailable'); }
		return result.targetInfo.targetId;
	}
	protected override disposeCore(): void {
		if (this.attachedHere && !this.contents.isDestroyed() && this.contents.debugger.isAttached()) { this.contents.debugger.detach(); }
		super.disposeCore();
	}
}
