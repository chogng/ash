interface Environment {
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	STATE_SIGNING_SECRET: string;
}

const callbackPath = '/v1/oauth/github/callback';
const authorizePath = '/v1/oauth/github/authorize';
const tokenPath = '/v1/oauth/github/token';
const flowLifetimeSeconds = 600;

interface SignedState {
	redirectUri: string;
	clientState: string;
	issuedAt: number;
}

export default {
	async fetch(request: Request, environment: Environment): Promise<Response> {
		const url = new URL(request.url);
		if (!environment.GITHUB_CLIENT_ID || !environment.GITHUB_CLIENT_SECRET || !environment.STATE_SIGNING_SECRET) {
			return response(503, 'GitHub authorization is not configured');
		}
		if (url.pathname === authorizePath && request.method === 'GET') return authorize(url, environment);
		if (url.pathname === callbackPath && request.method === 'GET') return callback(url, environment);
		if (url.pathname === tokenPath && request.method === 'POST') return exchange(request, url, environment);
		return response(404, 'Not found');
	},
};

async function authorize(url: URL, environment: Environment): Promise<Response> {
	const clientId = single(url.searchParams, 'client_id');
	const redirectUri = single(url.searchParams, 'redirect_uri');
	const clientState = single(url.searchParams, 'state');
	const challenge = single(url.searchParams, 'code_challenge');
	if (clientId !== environment.GITHUB_CLIENT_ID || !redirectUri || !validLoopback(redirectUri) || !base64url43(clientState) || !base64url43(challenge) || single(url.searchParams, 'code_challenge_method') !== 'S256') {
		return response(400, 'Invalid authorization request');
	}
	const state = await sign({ redirectUri, clientState, issuedAt: Math.floor(Date.now() / 1000) }, environment.STATE_SIGNING_SECRET);
	const github = new URL('https://github.com/login/oauth/authorize');
	github.searchParams.set('client_id', clientId);
	github.searchParams.set('redirect_uri', new URL(callbackPath, url.origin).href);
	github.searchParams.set('state', state);
	github.searchParams.set('code_challenge', challenge);
	github.searchParams.set('code_challenge_method', 'S256');
	return redirect(github.href);
}

async function callback(url: URL, environment: Environment): Promise<Response> {
	const state = await verify(single(url.searchParams, 'state'), environment.STATE_SIGNING_SECRET);
	if (!state || !validLoopback(state.redirectUri) || !base64url43(state.clientState)) return response(400, 'Invalid authorization response');
	const code = single(url.searchParams, 'code');
	const error = single(url.searchParams, 'error');
	if ((!code && !error) || (code && error)) return response(400, 'Invalid authorization response');
	const destination = new URL(state.redirectUri);
	destination.searchParams.set('state', state.clientState);
	if (code) destination.searchParams.set('code', code);
	if (error) destination.searchParams.set('error', error);
	return redirect(destination.href);
}

async function exchange(request: Request, url: URL, environment: Environment): Promise<Response> {
	if (request.headers.get('content-type')?.split(';', 1)[0] !== 'application/x-www-form-urlencoded') return response(415, 'Expected form data');
	const body = await request.text();
	if (body.length > 8192) return response(413, 'Request too large');
	const form = new URLSearchParams(body);
	const grantType = single(form, 'grant_type');
	const clientId = single(form, 'client_id');
	const code = single(form, 'code');
	const verifier = single(form, 'code_verifier');
	const redirectUri = single(form, 'redirect_uri');
	const refreshToken = single(form, 'refresh_token');
	if (clientId !== environment.GITHUB_CLIENT_ID || (grantType === 'authorization_code' && (!code || !base64url43(verifier) || !redirectUri || !validLoopback(redirectUri))) || (grantType === 'refresh_token' && !refreshToken) || !['authorization_code', 'refresh_token'].includes(grantType ?? '')) {
		return response(400, 'Invalid token request');
	}
	const githubForm = new URLSearchParams({ client_id: clientId, client_secret: environment.GITHUB_CLIENT_SECRET });
	if (grantType === 'authorization_code') {
		githubForm.set('code', code!);
		githubForm.set('code_verifier', verifier!);
		githubForm.set('redirect_uri', new URL(callbackPath, url.origin).href);
	} else {
		githubForm.set('grant_type', 'refresh_token');
		githubForm.set('refresh_token', refreshToken!);
	}
	const upstream = await fetch('https://github.com/login/oauth/access_token', {
		method: 'POST',
		headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
		body: githubForm,
	});
	if (!upstream.ok) return response(502, 'GitHub token exchange failed');
	const token = await upstream.json() as Record<string, unknown>;
	if (typeof token.error === 'string') {
		return new Response(JSON.stringify({ error: token.error }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
	}
	if (typeof token.access_token !== 'string' || !token.access_token || typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer') return response(502, 'GitHub token exchange failed');
	return new Response(JSON.stringify({
		access_token: token.access_token,
		refresh_token: token.refresh_token,
		expires_in: token.expires_in,
		refresh_token_expires_in: token.refresh_token_expires_in,
		token_type: token.token_type,
	}), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

function single(params: URLSearchParams, key: string): string | undefined {
	const values = params.getAll(key);
	return values.length === 1 && values[0] ? values[0] : undefined;
}

function base64url43(value: string | undefined): value is string {
	return value !== undefined && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function validLoopback(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== '' && /^\/github-oauth\/[A-Za-z0-9_-]{43}$/.test(url.pathname) && !url.search && !url.hash && !url.username && !url.password;
	} catch {
		return false;
	}
}

async function key(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function sign(state: SignedState, secret: string): Promise<string> {
	const data = base64url(new TextEncoder().encode(JSON.stringify(state)));
	const signature = await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(data));
	return `${data}.${base64url(new Uint8Array(signature))}`;
}

async function verify(value: string | undefined, secret: string): Promise<SignedState | undefined> {
	if (!value) return undefined;
	const [data, signature, extra] = value.split('.');
	if (!data || !signature || extra || data.length > 2048) return undefined;
	try {
		const valid = await crypto.subtle.verify('HMAC', await key(secret), fromBase64url(signature), new TextEncoder().encode(data));
		if (!valid) return undefined;
		const state = JSON.parse(new TextDecoder().decode(fromBase64url(data))) as SignedState;
		const age = Math.floor(Date.now() / 1000) - state.issuedAt;
		return Number.isInteger(state.issuedAt) && age >= 0 && age <= flowLifetimeSeconds ? state : undefined;
	} catch {
		return undefined;
	}
}

function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value: string): Uint8Array {
	return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
}

function redirect(location: string): Response {
	return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

function response(status: number, message: string): Response {
	return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}
