import { localize } from '../../../nls.js';
import { createServer } from 'node:http';

export class LoopbackOAuthCallback {
	private settled = false;
	private readonly completion: Promise<{ readonly state: string; readonly code: string; readonly issuer?: string }>;
	private resolve!: (value: { readonly state: string; readonly code: string; readonly issuer?: string }) => void;
	private reject!: (reason: Error) => void;
	private readonly timeout: NodeJS.Timeout;

	private constructor(
		private readonly server: ReturnType<typeof createServer>,
		readonly redirectUri: string,
		private readonly callbackPath: string,
	) {
		this.completion = new Promise((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
		void this.completion.catch(() => undefined);
		this.timeout = setTimeout(() => this.finishError(new Error('Connector OAuth callback timed out')), 10 * 60 * 1000);
	}

	static async listen(callbackPath: string): Promise<LoopbackOAuthCallback> {
		const server = createServer();
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => {
				server.removeListener('error', reject);
				resolve();
			});
		});
		const address = server.address();
		if (!address || typeof address === 'string') {
			server.close();
			throw new Error('Connector OAuth callback address is unavailable');
		}
		const callback = new LoopbackOAuthCallback(server, `http://127.0.0.1:${address.port}${callbackPath}`, callbackPath);
		server.on('request', (request, response) => callback.handle(request.method, request.url, response));
		server.on('error', () => callback.finishError(new Error('Connector OAuth callback host failed')));
		return callback;
	}

	wait(): Promise<{ readonly state: string; readonly code: string; readonly issuer?: string }> {
		return this.completion;
	}

	close(): void {
		this.finishError(new Error('Connector OAuth callback closed'));
		clearTimeout(this.timeout);
		this.server.close();
	}

	private handle(method: string | undefined, rawUrl: string | undefined, response: import('node:http').ServerResponse): void {
		if (method !== 'GET' || !rawUrl?.startsWith('/') || rawUrl.startsWith('//') || this.settled) {
			response.writeHead(404).end();
			return;
		}
		let url: URL;
		try {
			url = new URL(rawUrl, this.redirectUri);
		} catch {
			response.writeHead(400).end();
			return;
		}
		if (url.pathname !== this.callbackPath) {
			response.writeHead(404).end();
			return;
		}
		const states = url.searchParams.getAll('state');
		const codes = url.searchParams.getAll('code');
		const errors = url.searchParams.getAll('error');
		const issuers = url.searchParams.getAll('iss');
		response.setHeader('Content-Type', 'text/plain; charset=utf-8');
		if (states.length !== 1 || codes.length !== 1 || errors.length !== 0 || issuers.length > 1 || !states[0] || !codes[0]) {
			response.writeHead(400).end(localize({ bundle: 'ash.extensions', key: 'oauthCallbackInvalid' }, 'Authorization was not completed. You may close this window.'));
			this.finishError(new Error('Connector OAuth provider did not return a valid callback'));
			return;
		}
		response.writeHead(200).end(localize({ bundle: 'ash.extensions', key: 'oauthCallbackReceived' }, 'Authorization callback received. You may close this window and return to Ash.'));
		this.settled = true;
		clearTimeout(this.timeout);
		this.resolve({ state: states[0], code: codes[0], ...(issuers.length ? { issuer: issuers[0] } : {}) });
	}

	private finishError(error: Error): void {
		if (this.settled) return;
		this.settled = true;
		clearTimeout(this.timeout);
		this.reject(error);
		this.server.close();
	}
}
