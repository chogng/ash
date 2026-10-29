import { watch, type FSWatcher, type WatchEventType } from 'node:fs';

/** Watches one inode and rebinds after replacement, without watching its parent tree. */
export function watchNativeFile(path: string, onChange: (event: WatchEventType) => void, onError: (error: Error) => void): Pick<FSWatcher, 'close'> {
	let watcher: FSWatcher | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	let missing = false;

	function close(): void {
		closed = true;
		clearTimeout(retry);
		retry = undefined;
		watcher?.close();
		watcher = undefined;
	}

	function reopen(): void {
		if (closed) return;
		watcher?.close();
		watcher = undefined;
		try {
			bind();
		} catch (error) {
			close();
			onError(error as Error);
		}
	}

	function bind(): void {
		let current: FSWatcher;
		try {
			current = watch(path, event => {
				if (closed || watcher !== current) return;
				// fs.watch follows the old inode after an atomic save. Bind the new
				// inode before notifying the consumer, including later recreation.
				if (event === 'rename') reopen();
				onChange(event);
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			missing = true;
			// Only an absent file needs a registration retry. Existing files use
			// native events; no directory stream or periodic stat scan is created.
			retry = setTimeout(() => {
				retry = undefined;
				reopen();
			}, 100);
			return;
		}
		watcher = current;
		current.on('error', () => {
			if (!closed && watcher === current) reopen();
		});
		if (missing) {
			missing = false;
			onChange('rename');
		}
	}

	bind();
	return { close };
}
