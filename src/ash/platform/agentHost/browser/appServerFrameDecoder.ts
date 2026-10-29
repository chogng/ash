import { Disposable, MutableDisposable } from '../../../base/common/lifecycle.js';
import {
	WebWorkerClient,
	type WebWorkerClientPort,
	type IWebWorkerClient,
} from '../../../base/common/worker/webWorker.js';
import type { IWebWorkerService } from '../../webWorker/browser/webWorkerService.js';
import { WebWorkerDescriptor } from '../../webWorker/browser/webWorkerDescriptor.js';
import {
	appServerDecodeChannel,
	decodeAppServerFrame,
	readDecodedAppServerFrame,
	type AppServerDecodeContext,
	type DecodedAppServerFrame,
} from './appServerProtocolDecoding.js';

/** Owns one lazy decoder Worker for a Renderer connection. Small frames stay synchronous. */
export class AppServerFrameDecoder extends Disposable {
	private readonly worker = this._register(new MutableDisposable<IWebWorkerClient<object>>());
	private requestId = 0;

	constructor(private readonly createPort?: () => WebWorkerClientPort | IWebWorkerClient<object>) {
		super();
	}

	public decode(
		frame: string,
		byteLength: number,
		context: AppServerDecodeContext,
	): DecodedAppServerFrame | Promise<DecodedAppServerFrame> {
		this.assertNotDisposed();
		if (byteLength < 256 * 1024 || !this.createPort) return decodeAppServerFrame(frame, context);
		const worker = this.worker.value ?? (this.worker.value = this.createClient());
		return worker
			.request(++this.requestId, { frame, context }, new AbortController().signal)
			.then(value => readDecodedAppServerFrame(value, context));
	}

	private createClient(): IWebWorkerClient<object> {
		const port = this.createPort!();
		return 'request' in port ? port : new WebWorkerClient(port, appServerDecodeChannel);
	}

	/** Terminate work from a retired connection; never retry invalid data on the UI thread. */
	public reset(): void {
		this.worker.clear();
	}
}

/** Runtime composition supplies Worker authority; Node tools retain the synchronous decoder. */
export function createAppServerFrameDecoder(workers: IWebWorkerService): AppServerFrameDecoder {
	return new AppServerFrameDecoder(
		typeof Worker === 'undefined'
			? undefined
			: () =>
					workers.createWorkerClient(
						new WebWorkerDescriptor({
							label: 'ash-app-server-decode',
							channel: appServerDecodeChannel,
							createWorker: () =>
								new Worker(new URL('./appServerProtocolWorkerMain.ts', import.meta.url), {
									type: 'module',
									name: 'ash-app-server-decode',
								}),
						}),
					),
	);
}
