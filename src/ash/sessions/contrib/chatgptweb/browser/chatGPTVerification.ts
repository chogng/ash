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
	type Phase = 'discovery' | 'import' | 'requirements' | 'headers';
	const prepare = async (sidebar: boolean, setPhase: (phase: Phase) => void): Promise<Record<string, string>> => {
		let moduleUrl: string | undefined;
		let inspectedEntry: string | undefined;
		// Discover the resource loaded by the current official page, rather than pinning a
		// build hash. Main owns the deadline and closes the page if discovery stalls.
		while (!moduleUrl) {
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
				if (entry && entry !== inspectedEntry) {
					inspectedEntry = entry;
					const response = await originalFetch(entry, { credentials: 'omit' });
					if (!response.ok || !response.body) { throw new Error('Verification entry is unavailable'); }
					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let source = '';
					let length = 0;
					try {
						while (true) {
							const next = await reader.read();
							if (next.done) { break; }
							length += next.value.byteLength;
							if (length > 256 * 1024) { await reader.cancel(); throw new Error('Verification entry exceeds the limit'); }
							source += decoder.decode(next.value, { stream: true });
						}
						source += decoder.decode();
					} finally { reader.releaseLock(); }
					const reference = source.match(/\.\/sentinel-[\w-]+\.js/u)?.[0];
					if (reference) { moduleUrl = new URL(reference, entry).href; }
				}
			}
			if (!moduleUrl) { await new Promise<void>(resolve => setTimeout(resolve, 200)); }
		}
		setPhase('import');
		const module: unknown = await import(/* @vite-ignore */ moduleUrl);
		if (!module || typeof module !== 'object') { throw new Error('Invalid verification module'); }
		const api: unknown = Object.values(module).find(value => value && typeof value === 'object' && typeof value.finalizeChatRequirements === 'function');
		if (!api || typeof api !== 'object' || !('finalizeChatRequirements' in api) || typeof api.finalizeChatRequirements !== 'function') { throw new Error('Verification API is unavailable'); }
		setPhase('requirements');
		// Ash supplies authenticated request headers to this otherwise signed-out document.
		// The sidebar accepts the SDK's prepared result and completes verification with its request.
		if (sidebar) {
			if (!('primeChatRequirements' in api) || typeof api.primeChatRequirements !== 'function') { throw new Error('ChatGPT preparation API is unavailable'); }
			api.primeChatRequirements(true);
		}
		const value: unknown = await api.finalizeChatRequirements({ allowPreparedOnly: sidebar, requestSignal: new AbortController().signal });
		setPhase('headers');
		if (!value || typeof value !== 'object') { throw new Error('Invalid verification result'); }
		const headers: Record<string, string> = {};
		for (const [field, header] of [
			['chatRequirementsToken', 'OpenAI-Sentinel-Chat-Requirements-Token'],
			['chatRequirementsPrepareToken', 'OpenAI-Sentinel-Chat-Requirements-Prepare-Token'],
			['proofToken', 'OpenAI-Sentinel-Proof-Token'],
			['turnstileToken', 'OpenAI-Sentinel-Turnstile-Token'],
		] as const) {
			const token: unknown = Reflect.get(value, field);
			if (token !== undefined && token !== null) {
				if (typeof token !== 'string' || !token || token.length > 65536 || /[\r\n\0]/u.test(token)) { throw new Error('Invalid verification token'); }
				headers[header] = token;
			}
		}
		const required = sidebar ? 'OpenAI-Sentinel-Chat-Requirements-Prepare-Token' : 'OpenAI-Sentinel-Chat-Requirements-Token';
		if (!headers[required]) { throw new Error('Verification did not finish'); }
		return headers;
	};
	const target = globalThis as typeof globalThis & { __ashPrepareChatGPTHeaders?: (sidebar?: boolean) => Promise<Record<string, string> | { failedPhase: Phase; }>; };
	target.__ashPrepareChatGPTHeaders = async (sidebar = false) => {
		let phase: Phase = 'discovery';
		try {
			return await prepare(sidebar, next => { phase = next; });
		} catch {
			// Report the fixed stage, never an SDK error that could include request data.
			return { failedPhase: phase };
		}
	};
}
