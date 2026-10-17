import { Disposable, MutableDisposable } from '../../../base/common/lifecycle.js';
import { WebWorkerClient, type WebWorkerClientPort } from '../../../base/common/worker/webWorker.js';
import { BrowserWorkerClientPort } from '../../webWorker/browser/browserWorkerClientPort.js';
import { appServerDecodeChannel, decodeAppServerFrame, readDecodedAppServerFrame, type AppServerDecodeContext, type DecodedAppServerFrame } from './appServerProtocolDecoding.js';

/** Owns one lazy decoder Worker for a Renderer connection. Small frames stay synchronous. */
export class AppServerFrameDecoder extends Disposable {
	private readonly worker = this._register(new MutableDisposable<WebWorkerClient>());
	private requestId = 0;

	constructor(private readonly createPort: (() => WebWorkerClientPort) | undefined = typeof Worker === 'undefined' ? undefined : () => new BrowserWorkerClientPort(
		new Worker(new URL('./appServerProtocolWorkerMain.ts', import.meta.url), { type: 'module', name: 'ash-app-server-decode' }),
	)) { super(); }

	public decode(frame: string, byteLength: number, context: AppServerDecodeContext): DecodedAppServerFrame | Promise<DecodedAppServerFrame> {
		this.assertNotDisposed();
		if (byteLength < 256 * 1024 || !this.createPort) return decodeAppServerFrame(frame, context);
		const worker = this.worker.value ?? (this.worker.value = new WebWorkerClient(this.createPort(), appServerDecodeChannel));
		return worker.request(++this.requestId, { frame, context }, new AbortController().signal).then(value => readDecodedAppServerFrame(value, context));
	}

	/** Terminate work from a retired connection; never retry invalid data on the UI thread. */
	public reset(): void { this.worker.clear(); }
}
