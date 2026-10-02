import type { ViteDevServer } from 'vite';

/** Transforms the initial client graph without executing Renderer initialization. */
export async function prepareViteClient(server: ViteDevServer, entries: readonly string[], loggedErrors: readonly string[]): Promise<void> {
	const client = server.environments.client;
	await Promise.all(entries.map(async entry => {
		if (!await client.transformRequest(entry)) {
			throw new Error(`Vite did not transform the development entry: ${entry}`);
		}
	}));
	// Vite follows static imports with pre-transform requests. Listening, or even
	// transforming the entry itself, does not mean those dependencies have finished.
	await client.waitForRequestsIdle();
	// Vite catches background pre-transform errors and reports them through its logger.
	if (loggedErrors.length > 0) {
		throw new AggregateError(loggedErrors.map(message => new Error(message)), `Vite dependency preparation failed:\n${loggedErrors.join('\n')}`);
	}
}
