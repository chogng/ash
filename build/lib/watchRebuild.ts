export interface RebuildServer {
	readonly watcher: {
		on(event: 'all', listener: (event: string, path: string) => void): unknown;
		off(event: 'all', listener: (event: string, path: string) => void): unknown;
	};
	readonly httpServer?: {
		once(event: 'close', listener: () => void): unknown;
		off(event: 'close', listener: () => void): unknown;
	} | null;
	readonly config: { readonly logger: { error(message: string, options?: { error?: unknown; }): void; }; };
	readonly ws: { send(message: { type: 'full-reload'; }): void; };
}

/** Coalesces changes for generators that reread all their inputs on every run. */
export function watchRebuild(server: RebuildServer, accepts: (path: string) => boolean, build: () => Promise<boolean>, debounceMilliseconds = 50): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let running = false;
	let dirty = false;
	let closed = false;

	async function rebuild(): Promise<void> {
		if (closed || running || !dirty) { return; }
		dirty = false;
		running = true;
		try {
			const changed = await build();
			if (!closed && changed) { server.ws.send({ type: 'full-reload' }); }
		} catch (error) {
			if (!closed) { server.config.logger.error(error instanceof Error ? error.message : String(error), { error }); }
		} finally {
			running = false;
			// Keep one rerun for edits received during generation, respecting any remaining debounce.
			if (dirty && timer === undefined && !closed) { void rebuild(); }
		}
	}

	function onChange(event: string, path: string): void {
		if (closed || !['add', 'change', 'unlink'].includes(event) || !accepts(path)) { return; }
		dirty = true;
		clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			void rebuild();
		}, debounceMilliseconds);
	}

	function close(): void {
		closed = true;
		dirty = false;
		clearTimeout(timer);
		server.watcher.off('all', onChange);
		server.httpServer?.off('close', close);
	}

	server.watcher.on('all', onChange);
	server.httpServer?.once('close', close);
	// Vite's closeBundle hook also covers middleware servers without an HTTP server.
	return close;
}
