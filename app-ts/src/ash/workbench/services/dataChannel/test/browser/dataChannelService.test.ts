import assert from 'node:assert/strict';
import { test } from 'mocha';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { DataChannelForwardingTelemetryService, forwardToChannelIf } from '../../../../../platform/dataChannel/browser/forwardingTelemetryService.js';
import { IDataChannelService, parseLinkPresentation, type IDataChannelEvent, type ILinkPresentation } from '../../../../../platform/dataChannel/common/dataChannel.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ITelemetryService, type ITelemetryData } from '../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryServiceShape } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { DataChannelService, LinkPresentationService } from '../../browser/dataChannelService.js';

test('data channel telemetry forwards clean data and preserves base logging when forwarding is disabled', () => {
	using services = new InstantiationService();
	using channels = new DataChannelService();
	const baseEvents: string[] = [];
	class Telemetry extends NullTelemetryServiceShape {
		public override publicLog(eventName: string, _data?: ITelemetryData): void { baseEvents.push(eventName); }
		public override publicLogError(eventName: string, _data?: ITelemetryData): void { baseEvents.push(eventName); }
	}
	services.registerInstance(ITelemetryService, new Telemetry());
	services.registerInstance(IDataChannelService, channels);
	const telemetry = services.createInstance(DataChannelForwardingTelemetryService);
	const received: IDataChannelEvent[] = [];
	using listener = channels.onDidSendData(event => received.push(event));
	telemetry.publicLog('completion', { accepted: true, ...forwardToChannelIf(true) });
	telemetry.publicLogError('suppressed', { ...forwardToChannelIf(false) });
	telemetry.publicLog('empty');
	assert.deepEqual({ received, baseEvents }, {
		received: [
			{ channelId: 'editTelemetry', data: { eventName: 'completion', data: { accepted: true } } },
			{ channelId: 'editTelemetry', data: { eventName: 'empty', data: {} } },
		],
		baseEvents: ['completion', 'suppressed', 'empty'],
	});
	assert.deepEqual(Object.getOwnPropertySymbols((received[0]!.data as { data: object; }).data), []);
	const handle = channels.getDataChannel('editTelemetry');
	channels.dispose();
	assert.throws(() => handle.sendData({}), ReferenceError);
});

test('link rules honor context conditions, matching resources, and provider lifetime', () => {
	using services = new InstantiationService();
	using contexts = new ContextKeyService();
	services.registerInstance(IContextKeyService, contexts);
	using links = services.createInstance(LinkPresentationService);
	const value = observableValue<ILinkPresentation | undefined>('test', { kind: 'issue', title: 'Issue' });
	let disposed = 0;
	const provider = { createLinkPresentationWatcher: () => Object.assign(toDisposable(() => { disposed++; value.set(undefined); }), { presentation: value }) };
	using registration = links.registerLinkPresentationProvider({ id: 'issues', uriPattern: /^https:\/\/example\.com\/issues\//g, kind: 'issue', enablement: 'signedIn && !offline' }, provider);
	const resource = URI.parse('https://example.com/issues/1');
	assert.equal(links.getLinkPresentationRule(resource), undefined);
	contexts.setContext('signedIn', true);
	assert.equal(links.getLinkPresentationRule(resource)?.id, 'issues');
	assert.equal(links.getLinkPresentationRule(resource)?.id, 'issues');
	assert.equal(links.createLinkPresentationWatcher('issues', URI.parse('https://other.test/1')), undefined);
	using watcher = links.createLinkPresentationWatcher('issues', resource)!;
	assert.equal(watcher.presentation.get()?.title, 'Issue');
	contexts.setContext('offline', true);
	assert.deepEqual({ rules: links.linkPresentationRules, value: watcher.presentation.get(), disposed }, { rules: [], value: undefined, disposed: 1 });
	contexts.setContext('offline', false);
	using replacement = links.createLinkPresentationWatcher('issues', resource)!;
	registration.dispose();
	assert.equal(disposed, 2);
	assert.deepEqual(links.linkPresentationRules, []);
});

test('extension link payloads reject invalid states and keep independent normalized values', () => {
	const payload = { kind: 'pullRequest', title: '<script>untrusted</script>', changes: { insertions: 2, deletions: 1 }, status: { kind: 'merged', label: 'Merged' } };
	const presentation = parseLinkPresentation(payload);
	payload.changes.insertions = 99;
	assert.deepEqual(presentation.changes, { insertions: 2, deletions: 1 });
	for (const invalid of [null, [], { kind: 'unknown' }, { kind: 'file', status: { kind: 'success' } }, { kind: 'file', changes: { insertions: -1, deletions: 0 } }, { kind: 'file', changes: { insertions: Infinity, deletions: 0 } }, { kind: 'file', title: 42 }, { kind: 'file', isLoading: 'yes' }]) {
		assert.throws(() => parseLinkPresentation(invalid), TypeError);
	}
});
