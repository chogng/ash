import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { URI, type UriComponents } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AbstractURLService } from '../../common/urlService.js';
import { URLHandlerChannel, URLHandlerChannelClient } from '../../common/urlIpc.js';

class TestURLService extends AbstractURLService {
	public override create(options: Partial<UriComponents> = {}): URI {
		return URI.from({ ...options, scheme: 'ash' });
	}
}

suite('URL service', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('dispatch stops at the accepting handler and unregistering changes the next dispatch', async () => {
		using service = new TestURLService();
		const calls: string[] = [];
		using declined = service.registerHandler({ handleURL: async () => { calls.push('declined'); return false; } });
		using accepted = service.registerHandler({ handleURL: async () => { calls.push('accepted'); return true; } });
		using last = service.registerHandler({ handleURL: async () => { calls.push('last'); return false; } });
		assert.equal(await service.open(URI.parse('ash://callback/result')), true);
		assert.deepEqual(calls, ['declined', 'accepted']);
		accepted.dispose();
		calls.length = 0;
		assert.equal(await service.open(URI.parse('ash://callback/result')), false);
		assert.deepEqual(calls, ['declined', 'last']);
		service.dispose();
		assert.throws(() => service.registerHandler({ handleURL: async () => true }), /disposed/i);
		await assert.rejects(service.open(URI.parse('ash://callback/result')), /disposed/i);
	});

	test('handler errors reach the caller without invoking later handlers', async () => {
		using service = new TestURLService();
		using failing = service.registerHandler({ handleURL: async () => { throw new Error('Callback failed'); } });
		using last = service.registerHandler({ handleURL: async () => { assert.fail('Later handler must not run'); } });
		await assert.rejects(service.open(URI.parse('ash://callback/result')), /Callback failed/);
	});

	test('URL channel round trips encoded callback parameters and trust, and rejects malformed input', async () => {
		const received: unknown[] = [];
		const channel = new URLHandlerChannel({ handleURL: async (uri, options) => { received.push([uri.toString(), options]); return true; } });
		const client = new URLHandlerChannelClient({ call: (command, arg) => channel.call('window:1', command, JSON.parse(JSON.stringify(arg))), listen: () => { throw new Error('No events'); } });
		const uri = URI.parse('ash://callback/result?state=a%26b&code=%E4%BD%A0%2B%25#fragment');
		assert.equal(await client.handleURL(uri, { trusted: false, originalUrl: uri.toString() }), true);
		assert.equal(await client.handleURL(uri), true);
		assert.deepEqual(received, [[uri.toString(), { trusted: false, originalUrl: uri.toString() }], [uri.toString(), undefined]]);
		for (const arg of [[42, null], ['relative', null], [uri.toString(), { trusted: 'yes' }], [uri.toString(), { extra: true }]]) {
			await assert.rejects(channel.call('window:1', 'handleURL', arg), TypeError);
		}
		await assert.rejects(channel.call('window:1', 'other'), /Unknown URL operation/);
		const invalid = new URLHandlerChannelClient({ call: async <T>() => 'true' as T, listen: () => { throw new Error('No events'); } });
		await assert.rejects(invalid.handleURL(uri), /Invalid URL response/);
	});
});
