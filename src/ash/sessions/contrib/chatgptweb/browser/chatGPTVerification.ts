/**
 * Serialized by the product build and executed only on the official verification page.
 * Keep this function self-contained: no imported helpers or captured module state.
 * The official runtime performs the challenges; Ash supplies its authenticated transport.
 */
export function installChatGPTVerification(): void {
	const originalFetch = globalThis.fetch.bind(globalThis);
	globalThis.fetch = (input, init) => {
		const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
		if (url.origin === location.origin && /^\/(?:backend-anon|unauth-mweb)\/sentinel\//u.test(url.pathname)) {
			url.pathname = url.pathname.replace(/^\/(?:backend-anon|unauth-mweb)\//u, '/backend-api/');
			return originalFetch(input instanceof Request ? new Request(url, input) : url, init);
		}
		return originalFetch(input, init);
	};
	const target = globalThis as typeof globalThis & {
		__ashPrepareChatGPTHeaders?: () => Promise<Record<string, string>>;
	};
	target.__ashPrepareChatGPTHeaders = async () => {
		const signal = AbortSignal.timeout(25_000);
		let moduleUrl: string | undefined;
		// Discover the resource loaded by the current official page, rather than pinning a
		// build hash or relying on minified export names that change between releases.
		for (let attempt = 0; attempt < 50; attempt++) {
			signal.throwIfAborted();
			const resources = performance.getEntriesByType('resource').map(entry => entry.name);
			moduleUrl = resources.find(name => {
				const url = new URL(name);
				return url.origin === location.origin && /\/sentinel-[\w-]+\.js$/u.test(url.pathname);
			});
			// A detached verification page may never trigger the composer's idle prewarm.
			// Its loaded entry still declares the current module URL; read that declaration
			// without depending on composer visibility, a user gesture, or a fixed build hash.
			if (!moduleUrl) {
				const entry = resources.find(name => new URL(name).origin === location.origin && /\/native-initial-sentinel-prewarm-[\w-]+\.js$/u.test(new URL(name).pathname));
				if (entry) {
					const response = await originalFetch(entry, { credentials: 'omit', signal });
					if (!response.ok || !response.body) {
						throw new Error('Verification entry is unavailable');
					}
					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let source = '';
					let length = 0;
					try {
						while (true) {
							const next = await reader.read();
							if (next.done) {
								break;
							}
							length += next.value.byteLength;
							if (length > 256 * 1024) {
								await reader.cancel();
								throw new Error('Verification entry exceeds the limit');
							}
							source += decoder.decode(next.value, { stream: true });
						}
						source += decoder.decode();
					} finally {
						reader.releaseLock();
					}
					const reference = source.match(/\.\/sentinel-[\w-]+\.js/u)?.[0];
					if (reference) {
						moduleUrl = new URL(reference, entry).href;
					}
				}
			}
			if (moduleUrl) {
				break;
			}
			await new Promise<void>(resolve => setTimeout(resolve, 200));
		}
		if (!moduleUrl) {
			throw new Error('Verification runtime is unavailable');
		}
		const module: unknown = await import(/* @vite-ignore */ moduleUrl);
		if (!module || typeof module !== 'object') {
			throw new Error('Invalid verification module');
		}
		const api: unknown = Object.values(module).find(value => value && typeof value === 'object' && typeof value.finalizeChatRequirements === 'function');
		if (!api || typeof api !== 'object' || !('finalizeChatRequirements' in api) || typeof api.finalizeChatRequirements !== 'function') {
			throw new Error('Verification API is unavailable');
		}
		const value: unknown = await api.finalizeChatRequirements({ requestSignal: signal });
		if (!value || typeof value !== 'object') {
			throw new Error('Invalid verification result');
		}
		const headers: Record<string, string> = {};
		for (const [field, header] of [
			['chatRequirementsToken', 'OpenAI-Sentinel-Chat-Requirements-Token'],
			['proofToken', 'OpenAI-Sentinel-Proof-Token'],
			['turnstileToken', 'OpenAI-Sentinel-Turnstile-Token'],
		] as const) {
			const token: unknown = Reflect.get(value, field);
			if (token !== undefined && token !== null) {
				if (typeof token !== 'string' || !token || token.length > 65536 || /[\r\n\0]/u.test(token)) {
					throw new Error('Invalid verification token');
				}
				headers[header] = token;
			}
		}
		if (!headers['OpenAI-Sentinel-Chat-Requirements-Token']) {
			throw new Error('Verification did not finish');
		}
		return headers;
	};
}
