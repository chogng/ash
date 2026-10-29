import { isAbsolute } from 'node:path';
import { Client } from '../../../base/parts/ipc/common/ipc.mp.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { isRecord } from '../../../base/common/types.js';
import { URI } from '../../../base/common/uri.js';
import type { Event } from '../../../base/common/event.js';
import { LOCAL_FILE_SYSTEM_CHANNEL_NAME } from '../../../platform/files/common/diskFileSystemProviderClient.js';
import { DiskFileSystemProvider } from '../../../platform/files/node/diskFileSystemProvider.js';
import { AbstractDiskFileSystemProviderChannel } from '../../../platform/files/node/diskFileSystemProviderServer.js';

// Main grants one profile root at process launch; no renderer can widen this scope.
const [profileRoot, ...extra] = process.argv.slice(2);
if (!profileRoot || !isAbsolute(profileRoot) || profileRoot.includes('\0') || extra.length) {
	throw new TypeError('Invalid file watcher profile root');
}
const resources = new DisposableStore();
// Referenced watchers keep this process's Node event loop active for file notifications.
// Main owns the utility lifetime and terminates it when the application closes.
const provider = resources.add(new DiskFileSystemProvider([URI.file(profileRoot)], undefined, { persistent: true }));

class FileWatcherChannel extends AbstractDiskFileSystemProviderChannel<string> {
	public override listen<T>(context: string, event: string, value?: unknown): Event<T> {
		this.assertNotDisposed();
		if (event === 'watchError' && value === undefined) return provider.onDidWatchError as Event<T>;
		if (event !== 'watch' && event !== 'fileChange') throw new Error(`Unknown file watcher event: ${event}`);
		return super.listen(context, event, value);
	}

	public override async call<T>(): Promise<T> {
		// This process owns notifications only; all file mutations stay with Main.
		throw new Error('File watcher does not accept file operations');
	}
}

let connected = false;
process.parentPort.on('message', (event: Electron.MessageEvent) => {
	if (connected || !isRecord(event.data) || event.data.context !== 'profile' || event.ports.length !== 1) {
		throw new TypeError('Invalid file watcher connection');
	}
	connected = true;
	const [port] = event.ports;
	const client = resources.add(
		new Client(
			{
				postMessage: data => port.postMessage(data),
				start: () => port.start(),
				close: () => port.close(),
				addEventListener: (type, listener) => (type === 'message' ? port.on('message', listener) : port.on('close', listener as () => void)),
				removeEventListener: (type, listener) => (type === 'message' ? port.off('message', listener) : port.off('close', listener as () => void)),
			},
			'profile',
		),
	);
	client.registerChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME, resources.add(new FileWatcherChannel(provider)));
	port.once('close', () => resources.dispose());
});
process.once('exit', () => resources.dispose());
