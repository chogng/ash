import { decodeAppServerServerRequestParams } from '../../app-server/common/generated/AppServerProtocolDecoder.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { isRecord } from '../../../base/common/types.js';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';
import type { BrowserAutomationMainService } from './browserAutomationMainService.js';

/** Owns cancellable browser operations requested by one renderer. */
export class BrowserAutomationHost extends Disposable {
	private readonly operations = new Map<string, AbortController>();
	constructor(private readonly service: BrowserAutomationMainService) {
		super();
		this._register(toDisposable(() => { for (const controller of this.operations.values()) { controller.abort(); } this.operations.clear(); }));
	}

	public routes(): readonly IpcRoute<unknown, unknown>[] {
		const operation = (value: unknown): { id: string; params: unknown } => {
			if (!isRecord(value) || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id)) { throw new Error('Invalid browser operation'); }
			return { id: value.id, params: value.params };
		};
		const run = async (value: unknown, execute: (params: unknown, context: { signal: AbortSignal }) => unknown | Promise<unknown>): Promise<unknown> => {
			this.assertNotDisposed();
			const request = operation(value);
			if (this.operations.has(request.id) || this.operations.size >= 128) { throw new Error('Browser operation capacity exceeded'); }
			const controller = new AbortController();
			this.operations.set(request.id, controller);
			const timer = setTimeout(() => controller.abort(), 30_000);
			try { return await execute(request.params, { signal: controller.signal }); }
			finally { clearTimeout(timer); this.operations.delete(request.id); }
		};
		return [
			{ channel: 'ash:browser-host:create', validate: operation, invoke: value => run(value, (params, context) => this.service.create(decodeAppServerServerRequestParams('browser/create', params), context)) },
			{ channel: 'ash:browser-host:observe', validate: operation, invoke: value => run(value, (params, context) => this.service.observe(decodeAppServerServerRequestParams('browser/observe', params), context)) },
			{ channel: 'ash:browser-host:perform', validate: operation, invoke: value => run(value, (params, context) => this.service.perform(decodeAppServerServerRequestParams('browser/perform', params), context)) },
			{ channel: 'ash:browser-host:close', validate: operation, invoke: value => run(value, params => this.service.close(decodeAppServerServerRequestParams('browser/close', params))) },
			{ channel: 'ash:browser-host:cancel', validate: operation, invoke: value => { this.operations.get(operation(value).id)?.abort(); } },
		];
	}
}
