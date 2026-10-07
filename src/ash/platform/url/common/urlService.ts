import { LinkedList } from '../../../base/common/linkedList.js';
import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import type { URI, UriComponents } from '../../../base/common/uri.js';
import type { IOpenURLOptions, IURLHandler, IURLService } from './url.js';

/** A window owns its handler registrations; dispatch stops at the first accepted link. */
export abstract class AbstractURLService extends Disposable implements IURLService {
	declare public readonly _serviceBrand: undefined;
	private readonly handlers = new LinkedList<IURLHandler>();

	constructor() {
		super();
		this._register(toDisposable(() => this.handlers.clear()));
	}

	public abstract create(options?: Partial<UriComponents>): URI;

	public async open(uri: URI, options?: IOpenURLOptions): Promise<boolean> {
		this.assertNotDisposed();
		const handlers = [...this.handlers];
		for (const handler of handlers) {
			if (await handler.handleURL(uri, options)) {
				return true;
			}
		}
		return false;
	}

	public registerHandler(handler: IURLHandler): IDisposable {
		this.assertNotDisposed();
		return toDisposable(this.handlers.push(handler));
	}
}
