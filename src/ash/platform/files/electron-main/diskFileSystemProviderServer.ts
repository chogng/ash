import { URI } from '../../../base/common/uri.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { canceled } from '../../../base/common/errors.js';
import { AbstractDiskFileSystemProviderChannel } from '../node/diskFileSystemProviderServer.js';
import { DiskFileSystemProvider } from '../node/diskFileSystemProvider.js';

/** Adds the desktop profile location to the validated storage channel. */
export class DiskFileSystemProviderChannel extends AbstractDiskFileSystemProviderChannel<string> {
	constructor(provider: DiskFileSystemProvider, private readonly userDataHome: URI) {
		super(provider);
	}

	public override async call<T>(context: string, command: string, value?: unknown, token: CancellationToken = CancellationToken.None): Promise<T> {
		this.assertNotDisposed();
		if (command === 'userDataHome') {
			if (token.isCancellationRequested) { throw canceled(); }
			if (value !== undefined) { throw new TypeError('No arguments expected'); }
			return this.userDataHome.toString() as T;
		}
		return super.call(context, command, value, token);
	}
}
