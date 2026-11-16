/**
 * Serialized by the product build and executed only on the official verification page.
 * Keep this function self-contained: no imported helpers or captured module state.
 * The official runtime performs the challenges; Ash supplies its authenticated transport.
 */
export function installChatGPTVerification(): void {
	// Module discovery/import can overlap the document's deferred scripts. The
	// official page still owns session initialization before requirements are primed.
	const documentReady = document.readyState !== 'loading' ? Promise.resolve() : new Promise<void>(resolve => {
		document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
	});
	const originalFetch = globalThis.fetch.bind(globalThis);
	let verificationRequests = 0;
	globalThis.fetch = (input, init) => {
		const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
		if (url.origin === location.origin && /^\/(?:backend-api|backend-anon|unauth-mweb)\/sentinel\/chat-requirements(?:\/(?:prepare|finalize))?$/u.test(url.pathname)) verificationRequests++;
		if (url.origin === location.origin && /^\/(?:backend-anon|unauth-mweb)\/sentinel\//u.test(url.pathname)) {
			url.pathname = url.pathname.replace(/^\/(?:backend-anon|unauth-mweb)\//u, '/backend-api/');
			return originalFetch(input instanceof Request ? new Request(url, input) : url, init);
		}
		return originalFetch(input, init);
	};
	type Phase = 'discovery' | 'import' | 'requirements' | 'headers';
	type VerificationApi = {
		finalizeChatRequirements(options: { allowPreparedOnly: boolean; refreshRequirements: boolean; requestSignal: AbortSignal; }): unknown;
	};
	const loadApi = async (setPhase: (phase: Phase) => void): Promise<VerificationApi> => {
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
		const api = Object.values(module).find((value: unknown): value is VerificationApi => !!value && typeof value === 'object' && 'finalizeChatRequirements' in value && typeof value.finalizeChatRequirements === 'function');
		if (!api) { throw new Error('Verification API is unavailable'); }
		return api;
	};
	let loadedApi: ReturnType<typeof loadApi> | undefined;
	const getApi = (setPhase: (phase: Phase) => void) => loadedApi ??= loadApi(setPhase);
	const prepare = async (sidebar: boolean, setPhase: (phase: Phase) => void): Promise<Record<string, string>> => {
		const api = await getApi(setPhase);
		await documentReady;
		setPhase('requirements');
		// Ash supplies authenticated request headers to this otherwise signed-out document.
		// The sidebar accepts the SDK's prepared result and completes verification with its request.
		if (sidebar) {
			if (!('primeChatRequirements' in api) || typeof api.primeChatRequirements !== 'function') { throw new Error('ChatGPT preparation API is unavailable'); }
			api.primeChatRequirements(true);
		}
		// A sidebar needs a prepared-only result, independent of a fully primed reply.
		const value: unknown = await api.finalizeChatRequirements({ allowPreparedOnly: sidebar, refreshRequirements: sidebar, requestSignal: new AbortController().signal });
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
	const target = globalThis as typeof globalThis & {
		__ashWarmChatGPTVerification?: () => Promise<{ readonly requestsStarted: boolean; }>;
		__ashPrepareChatGPTHeaders?: (sidebar?: boolean) => Promise<Record<string, string> | { failedPhase: Phase; }>;
	};
	// The SDK owns expiry and one-use consumption. Keep its prepared result inside
	// this account-bound document; Main waits for finalization before freezing it.
	target.__ashWarmChatGPTVerification = async () => {
		const api = await getApi(() => { });
		await documentReady;
		if (!('primeChatRequirementsEnforcement' in api) || typeof api.primeChatRequirementsEnforcement !== 'function'
			|| !('waitForPrimedChatRequirements' in api) || typeof api.waitForPrimedChatRequirements !== 'function') {
			throw new Error('ChatGPT preparation API is unavailable');
		}
		const previousRequests = verificationRequests;
		api.primeChatRequirementsEnforcement(undefined, true);
		await api.waitForPrimedChatRequirements();
		return { requestsStarted: verificationRequests !== previousRequests };
	};
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
