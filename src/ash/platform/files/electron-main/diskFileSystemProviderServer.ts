import { URI } from '../../../base/common/uri.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { canceled } from '../../../base/common/errors.js';
import { AbstractDiskFileSystemProviderChannel } from '../node/diskFileSystemProviderServer.js';
import { DiskFileSystemProvider } from '../node/diskFileSystemProvider.js';

/** Adds the desktop profile and OS home locations to the validated storage channel. */
export class DiskFileSystemProviderChannel extends AbstractDiskFileSystemProviderChannel<string> {
	constructor(provider: DiskFileSystemProvider, private readonly userDataHome: URI, private readonly userHome: URI) {
		super(provider);
	}

	public override async call<T>(context: string, command: string, value?: unknown, token: CancellationToken = CancellationToken.None): Promise<T> {
		this.assertNotDisposed();
		if (command === 'userDataHome' || command === 'userHome') {
			if (token.isCancellationRequested) { throw canceled(); }
			if (value !== undefined) { throw new TypeError('No arguments expected'); }
			return (command === 'userDataHome' ? this.userDataHome : this.userHome).toString() as T;
		}
		return super.call(context, command, value, token);
	}
}
