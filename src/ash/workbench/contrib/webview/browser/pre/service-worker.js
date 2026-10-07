/* Workers can be stopped while idle. The live bootstrap owns document and request state. */

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

function documentChannelFromUrl(url) {
	const prefix = new URL('document/', self.location.href).pathname;
	if (url.protocol !== self.location.protocol || url.host !== self.location.host || !url.pathname.startsWith(prefix)) return undefined;
	const channel = decodeURIComponent(url.pathname.slice(prefix.length));
	return /^ash-webview:[\da-f-]+:\d+$/.test(channel) ? channel : undefined;
}

async function loadFromBootstrap(event, type, documentChannel) {
	if (!documentChannel) return new Response(null, { status: 410 });
	const ownerChannel = documentChannel.slice(0, documentChannel.lastIndexOf(':'));
	const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
	const bootstrap = windows.find(client => {
		const url = new URL(client.url);
		return /\/index(?:-[\w-]+)?\.html$/.test(url.pathname) && new URLSearchParams(url.hash.slice(1)).get('channel') === ownerChannel;
	});
	if (!bootstrap) return new Response(null, { status: 410 });
	const connection = new MessageChannel();
	return new Promise(resolve => {
		connection.port1.onmessage = messageEvent => {
			connection.port1.close();
			const response = messageEvent.data;
			resolve(new Response(event.request.method === 'HEAD' ? null : response.body, {
				status: response.status,
				headers: { 'Content-Type': response.mimeType || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*' },
			}));
		};
		bootstrap.postMessage({ type, documentChannel, url: event.request.url }, [connection.port2]);
	});
}

self.addEventListener('fetch', event => {
	const url = new URL(event.request.url);
	const documentChannel = documentChannelFromUrl(url);
	if (documentChannel) {
		event.respondWith(loadFromBootstrap(event, 'load-document', documentChannel));
		return;
	}
	if (url.origin !== 'https://resources.ash-webview.invalid') return;
	event.respondWith((async () => {
		if (!['GET', 'HEAD'].includes(event.request.method)) return new Response(null, { status: 403 });
		const client = await self.clients.get(event.clientId);
		return loadFromBootstrap(event, 'load-resource', client ? documentChannelFromUrl(new URL(client.url)) : undefined);
	})());
});
