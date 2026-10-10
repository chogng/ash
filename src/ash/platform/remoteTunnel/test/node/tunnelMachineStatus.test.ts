import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { parseTunnelMachineStatus, TUNNEL_MACHINE_STATUS_PREFIX } from '../../node/tunnelMachineStatus.js';

suite('Inbound tunnel machine status', () => {
	const record = { relayHost: 'ash-relay', relayPort: 43123, web: { endpoint: 'http://127.0.0.1:5174/', ticket: 'a'.repeat(64), pid: 42 } };
	const parse = (value: unknown) => parseTunnelMachineStatus(TUNNEL_MACHINE_STATUS_PREFIX + JSON.stringify(value));
	test('keeps the ticket in the fragment and retains the original host and port', () => {
		const value = parse(record);
		assert.equal(value?.type, 'connected');
		if (value?.type !== 'connected' || !value.link) { throw new Error('Missing connection'); }
		const url = new URL(value.link);
		assert.deepEqual({ host: url.host, query: url.search, relay: value.domain, port: value.tunnelId }, { host: '127.0.0.1:5174', query: '', relay: 'ash-relay', port: '43123' });
		assert.equal(new URLSearchParams(url.hash.slice(1)).get('ash-ticket'), record.web.ticket);
	});
	test('rejects invalid or authority-injecting helper records', () => {
		for (const value of [
			{ ...record, relayHost: '-oProxyCommand=bad' },
			{ ...record, relayPort: 0 },
			{ ...record, relayPort: 65536 },
			{ ...record, profileRoot: '/other' },
			{ ...record, web: { ...record.web, endpoint: 'http://0.0.0.0:5174/' } },
			{ ...record, web: { ...record.web, ticket: 'bad' } },
		]) { assert.equal(parse(value), undefined); }
		assert.equal(parseTunnelMachineStatus('SSH diagnostics'), undefined);
	});
});
