import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import assert from 'node:assert/strict';
import { test, suite } from 'mocha';
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

test('link consumers share one live watcher until its last reference is released', () => {
	using services = new InstantiationService();
	using contexts = new ContextKeyService();
	services.registerInstance(IContextKeyService, contexts);
	using links = services.createInstance(LinkPresentationService);
	let created = 0;
	let disposed = 0;
	using registration = links.registerLinkPresentationProvider({ id: 'issues', uriPattern: /^https:\/\/example\.com\//u, kind: 'issue' }, {
		createLinkPresentationWatcher: () => {
			const presentation = observableValue<ILinkPresentation | undefined>('issue', { kind: 'issue', title: `Issue ${++created}` });
			return Object.assign(toDisposable(() => { disposed++; }), { presentation });
		},
	});
	const resource = URI.parse('https://example.com/issues/1');
	using first = links.createLinkPresentationWatcher('issues', resource)!;
	using second = links.createLinkPresentationWatcher('issues', resource)!;
	assert.equal(first.presentation, second.presentation);
	assert.equal(created, 1);
	first.dispose();
	assert.equal(disposed, 0);
	second.dispose();
	assert.equal(disposed, 1);
	using reopened = links.createLinkPresentationWatcher('issues', resource)!;
	assert.equal(reopened.presentation.get()?.title, 'Issue 2');
	registration.dispose();
	reopened.dispose();
	assert.equal(disposed, 2);
});

suite('dataChannel browser component', () => {
	const browserTests = useBrowserTests();
	test('extension channel delivery and Chat link updates retain keyboard navigation and targets', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => { errors.push(error.message); console.error(error.stack); });
		await page.goto('/dataChannel.html');
		const link = page.locator('a.ash-chat-rich-link[href="https://example.com/issues/1"]').or(page.getByRole('link', { name: 'Original issue', exact: true }));
		await expect(link).toHaveText('Issue one · #1 · Open · +2 −1');
		await expect(link).toHaveAccessibleName('Issue one · #1 · Open · +2 −1');
		await expect(link.locator('.ash-chat-rich-link-status')).toHaveText('Open');
		const authored = page.getByRole('link', { name: 'Another issue · Open', exact: true });
		await expect(authored.locator('em')).toHaveText('issue');
		const action = page.getByRole('link', { name: 'Open issue', exact: true });
		await action.hover();
		await expect(page.getByRole('dialog', { name: 'Link preview' })).toContainText('Issue one');
		const citation = page.getByRole('button', { name: '1 source' });
		await citation.press('Enter');
		const source = page.getByRole('dialog', { name: '1 source' }).getByRole('link', { name: 'example.com Search title', exact: true });
		await source.hover();
		await expect(page.getByRole('tooltip')).toContainText('Search snippet');
		await expect(page.getByRole('tooltip')).toContainText('Issue one');
		await expect(page.locator('body')).toHaveAttribute('data-link-requests', '2');
		await page.getByRole('button', { name: 'Publish edit event' }).click();
		await expect(page.getByRole('status', { name: 'Extension channel delivery' })).toHaveText('{"data":{"eventName":"inlineCompletion.endOfLife","data":{"accepted":true,"durationMs":5}}}');
		await page.getByRole('button', { name: 'Replace extension' }).click();
		await expect(link).toHaveText('<img src=x onerror=alert(1)> · #1 · Open · +2 −1');
		await expect(link).toBeFocused();
		await expect(link.locator('img')).toHaveCount(0);
		await page.keyboard.press('Enter');
		await expect(page.getByRole('status', { name: 'Opened target' })).toHaveText('https://example.com/issues/1');
		await expect(page.getByRole('status', { name: 'Extension URL delivery' })).toHaveText(JSON.stringify({ incarnation: 2, payload: { resolvedUri: 'https://example.com/issues/1', sourceUri: 'https://example.com/issues/1' } }));
		await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
		await expect(link).toHaveText('Original issue');
		await expect(link.locator('em')).toHaveText('issue');
		await expect(link).not.toHaveAttribute('aria-busy');
		await link.focus();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('status', { name: 'Extension URL delivery' })).toHaveText('default:https://example.com/issues/1');
		await expect(page.getByRole('link', { name: 'Plain link' })).toHaveAttribute('href', 'https://example.org/100%');
		expect(errors).toEqual([]);
	});
});
