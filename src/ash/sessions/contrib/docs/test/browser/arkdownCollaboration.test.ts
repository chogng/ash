import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('Arkdown collaboration rooms', () => {
	const browser = useBrowserTests();
	const mount = async () => { await browser.page.goto('/arkdownCollaboration.html'); await expect(browser.page.locator('body')).toHaveAttribute('data-ready', 'true'); };
	const connect = async () => { await browser.page.evaluate(async () => { await window.arkdownCollaborationFixture.connect(0); await window.arkdownCollaborationFixture.connect(1, 'room-1'); }); };
	for (const confirmed of [false, true]) test(`remote edits remain isolated until joining is confirmed: ${confirmed}`, async () => {
		await mount();
		await browser.page.evaluate(async () => { const f = window.arkdownCollaborationFixture; await f.connect(0); f.beginJoin(); });
		await expect.poll(() => browser.page.evaluate(() => window.arkdownCollaborationFixture.awaitingConfirmation)).toBe(true);
		await browser.page.evaluate(() => window.arkdownCollaborationFixture.edit(0, 0, 'remote '));
		// The source has submitted while the second document still awaits a decision.
		await expect.poll(() => browser.page.evaluate(() => window.arkdownCollaborationFixture.traffic.submitAttempts)).toBeGreaterThan(0);
		assert.equal(await browser.page.evaluate(() => window.arkdownCollaborationFixture.text(1)), 'local draft');
		assert.equal(await browser.page.evaluate(() => window.arkdownCollaborationFixture.dirty(1)), false);
		await browser.page.evaluate(value => window.arkdownCollaborationFixture.finishJoin(value), confirmed);
		if (confirmed) {
			await expect.poll(() => browser.page.evaluate(() => window.arkdownCollaborationFixture.text(1))).toBe('remote # Shared\n\nalpha🙂');
		} else {
			assert.equal(await browser.page.evaluate(() => window.arkdownCollaborationFixture.text(1)), 'local draft');
			assert.equal(await browser.page.evaluate(() => window.arkdownCollaborationFixture.listeners), 1);
		}
	});
	test('a local change during the confirmation prevents replacement', async () => {
		await mount();
		await browser.page.evaluate(async () => { const f = window.arkdownCollaborationFixture; await f.connect(0); f.beginJoin(); });
		await expect.poll(() => browser.page.evaluate(() => window.arkdownCollaborationFixture.awaitingConfirmation)).toBe(true);
		await browser.page.evaluate(async () => { const f = window.arkdownCollaborationFixture; f.edit(1, 0, 'changed '); await f.finishJoin(true); });
		assert.equal(await browser.page.evaluate(() => window.arkdownCollaborationFixture.text(1)), 'changed local draft');
		assert.equal(await browser.page.evaluate(() => window.arkdownCollaborationFixture.active[1]), false);
	});

	for (const locale of ['en', 'zh-CN']) test(`remote changes expose source labels, inserted and removed text, and rich/source highlights: ${locale}`, async () => {
		await browser.page.goto(`/arkdownCollaboration.html?locale=${locale}`);
		await expect(browser.page.locator('body')).toHaveAttribute('data-ready', 'true');
		await connect();
		await browser.page.evaluate(() => window.arkdownCollaborationFixture.edit(0, 12, '远端🙂'));
		const history = browser.page.locator('#b .stanza-arkdown-remote-history');
		await expect(history).toBeVisible();
		const summary = history.locator('summary');
		await expect(summary).toHaveText(locale === 'en' ? 'Recent remote changes (1)' : '近期远端修改（1）');
		await summary.focus(); await summary.press('Enter');
		await expect(history.locator('ins')).toHaveText(locale === 'en' ? 'Inserted: 远端🙂' : '插入：远端🙂');
		const change = await browser.page.evaluate(() => window.arkdownCollaborationFixture.recentChanges(1)[0]);
		await expect(history.locator('li > span')).toHaveText(`${locale === 'en' ? 'Connection ' : '连接 '}${change.clientId}`);
		assert.deepEqual(await browser.page.evaluate(() => {
			const registry = CSS.highlights;
			return [...registry].filter(([name]) => name.startsWith('arkdown-')).flatMap(([, ranges]) => [...ranges].map(range => range.toString()));
		}), ['远端🙂']);
		// Local typing at the end of a remote range must not inherit its highlight.
		await browser.page.evaluate(() => window.arkdownCollaborationFixture.edit(1, 16, ' local'));
		assert.equal(await browser.page.evaluate(() => { const f = window.arkdownCollaborationFixture; const c = f.recentChanges(1)[0]; return f.text(1).slice(c.start, c.end); }), '远端🙂');
		await browser.page.evaluate(async () => { await window.arkdownCollaborationFixture.show(1, 'original'); });
		await expect(history).toBeVisible();
		const group = browser.page.locator('#b');
		await browser.page.evaluate(() => window.arkdownCollaborationFixture.replace(0, 12, 16, ''));
		await expect.poll(() => browser.page.evaluate(() => window.arkdownCollaborationFixture.recentChanges(1)[0]?.removed)).toBe('远端🙂');
		// Reopening a pane borrows the same session, including its recent changes.
		await group.locator('.stanza-arkdown-remote-history summary').click();
		await expect(history.locator('del').first()).toContainText('远端🙂');
		await browser.page.evaluate(() => window.arkdownCollaborationFixture.edit(0, 12, 'new'));
		await expect.poll(() => browser.page.evaluate(() => window.arkdownCollaborationFixture.recentChanges(1)[0]?.inserted)).toBe('new');
		// The toolbar is supplied by the real pane; source and prose share this model.
		await browser.page.evaluate(() => window.arkdownCollaborationFixture.source(1));
		await expect(group.locator('.stanza-arkdown-source .arkdown-remote-change').first()).toHaveText('new');
		const accessible = await browser.page.evaluate(() => window.arkdownCollaborationFixture.accessible(1));
		assert.ok(accessible.includes('远端🙂') && accessible.includes(change.clientId!));
		await browser.page.evaluate(() => window.arkdownCollaborationFixture.leave(1));
		await expect(history).toBeHidden();
	});
	test('two file buffers converge, selective undo preserves remote text, and save uses the same model', async () => {
		await mount(); await connect();
		await browser.page.evaluate(() => { window.arkdownCollaborationFixture.edit(0, 12, '甲'); window.arkdownCollaborationFixture.edit(1, 12, '乙'); });
		await expect.poll(() => browser.page.evaluate(() => { const f = window.arkdownCollaborationFixture; return f.text(0) === f.text(1) && f.text(0).includes('甲') && f.text(0).includes('乙'); })).toBe(true);
		await browser.page.evaluate(() => window.arkdownCollaborationFixture.undo(0));
		await expect.poll(() => browser.page.evaluate(() => { const f = window.arkdownCollaborationFixture; return f.text(0) === f.text(1) && !f.text(0).includes('甲') && f.text(0).includes('乙'); })).toBe(true);
		await browser.page.evaluate(() => window.arkdownCollaborationFixture.redo(0));
		await expect.poll(() => browser.page.evaluate(() => window.arkdownCollaborationFixture.text(1))).toContain('甲');
		await browser.page.evaluate(() => window.arkdownCollaborationFixture.save(0));
		assert.equal(await browser.page.evaluate(() => window.arkdownCollaborationFixture.saved(0)), await browser.page.evaluate(() => window.arkdownCollaborationFixture.text(1)));
	});
	test('remote change history bounds its records and Unicode previews', async () => {
		await mount(); await connect();
		await browser.page.evaluate(() => window.arkdownCollaborationFixture.edit(0, 0, '文'.repeat(159) + '🙂tail'));
		await expect.poll(() => browser.page.evaluate(() => window.arkdownCollaborationFixture.recentChanges(1)[0]?.inserted)).toBe('文'.repeat(159) + '🙂');
		for (let index = 0; index < 21; index++) {
			const text = String.fromCodePoint(0x4e00 + index);
			await browser.page.evaluate(value => window.arkdownCollaborationFixture.edit(0, 0, value), text);
			await expect.poll(() => browser.page.evaluate(() => window.arkdownCollaborationFixture.recentChanges(1)[0]?.inserted)).toBe(text);
		}
		assert.equal(await browser.page.evaluate(() => window.arkdownCollaborationFixture.recentChanges(1).length), 20);
	});
	test('offline edits reconnect and an uncertain accepted packet is retried identically', async () => {
		await mount(); await connect();
		await browser.page.evaluate(() => { const f = window.arkdownCollaborationFixture; f.online(false); f.edit(0, 12, '离线甲'); f.edit(1, 12, '离线乙'); });
		await browser.page.waitForTimeout(50);
		await browser.page.evaluate(() => { window.arkdownCollaborationFixture.loseResponse(); window.arkdownCollaborationFixture.online(true); });
		await expect.poll(() => browser.page.evaluate(() => { const f = window.arkdownCollaborationFixture; return f.text(0) === f.text(1) && f.text(0).includes('离线甲') && f.text(0).includes('离线乙') && f.duplicates > 0; })).toBe(true);
	});
	test('shared CodeEditor edits use the CRDT participant and leaving releases subscriptions', async () => {
		await mount(); await connect();
		const source = browser.page.getByRole('textbox', { name: 'Shared source', exact: true });
		await source.focus(); await source.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End'); await browser.page.keyboard.insertText(' code');
		await expect.poll(() => browser.page.evaluate(() => window.arkdownCollaborationFixture.text(1))).toContain(' code');
		await browser.page.evaluate(() => { window.arkdownCollaborationFixture.leave(0); window.arkdownCollaborationFixture.leave(1); });
		assert.equal(await browser.page.evaluate(() => window.arkdownCollaborationFixture.listeners), 0);
		await browser.page.evaluate(() => window.arkdownCollaborationFixture.edit(0, 0, 'local '));
		assert.ok(!(await browser.page.evaluate(() => window.arkdownCollaborationFixture.text(1))).startsWith('local '));
	});
	test('EOL edits converge and undo through collaborative history', async () => {
		await mount(); await connect();
		await browser.page.evaluate(() => window.arkdownCollaborationFixture.crlf(0));
		await expect.poll(() => browser.page.evaluate(() => window.arkdownCollaborationFixture.text(1))).toBe('# Shared\r\n\r\nalpha🙂');
		await browser.page.evaluate(() => window.arkdownCollaborationFixture.undo(0));
		await expect.poll(() => browser.page.evaluate(() => window.arkdownCollaborationFixture.text(1))).toBe('# Shared\n\nalpha🙂');
	});
	test('cancelling replacement retains the draft and releases the room', async () => {
		await mount();
		await browser.page.evaluate(async () => { const f = window.arkdownCollaborationFixture; await f.connect(0); f.confirm(false); await f.connect(1, 'room-1'); });
		assert.equal(await browser.page.evaluate(() => window.arkdownCollaborationFixture.text(1)), 'local draft');
		assert.equal(await browser.page.evaluate(() => window.arkdownCollaborationFixture.listeners), 1);
		await browser.page.evaluate(() => window.arkdownCollaborationFixture.edit(1, 0, 'kept '));
		assert.equal(await browser.page.evaluate(() => window.arkdownCollaborationFixture.text(1)), 'kept local draft');
	});
	test('viewer model mutations are rejected before source or history changes', async () => {
		await mount(); await browser.page.evaluate(async () => { const f = window.arkdownCollaborationFixture; await f.connect(0); f.viewer(); await f.connect(1, 'room-1'); });
		const original = await browser.page.evaluate(() => window.arkdownCollaborationFixture.text(1));
		assert.equal(await browser.page.evaluate(() => { try { window.arkdownCollaborationFixture.edit(1, 0, 'bad'); return false; } catch { return true; } }), true);
		assert.equal(await browser.page.evaluate(() => window.arkdownCollaborationFixture.text(1)), original);
		await expect(browser.page.locator('#b').getByRole('textbox', { name: 'Document body', exact: true })).toHaveAttribute('aria-readonly', 'true');
	});
	test('room restart never acknowledges unpublished operations', async () => {
		await mount(); await connect();
		await browser.page.evaluate(() => window.arkdownCollaborationFixture.edit(0, 0, 'accepted '));
		await expect.poll(() => browser.page.evaluate(() => window.arkdownCollaborationFixture.text(1))).toContain('accepted ');
		await browser.page.evaluate(() => { const f = window.arkdownCollaborationFixture; f.online(false); f.edit(0, 0, 'offline A '); f.edit(1, 0, 'offline B '); f.restart(); f.online(true); });
		await expect.poll(() => browser.page.evaluate(() => { const f = window.arkdownCollaborationFixture; return f.text(0) === f.text(1) && f.text(0).includes('offline A') && f.text(0).includes('offline B'); })).toBe(true);
	});
	test('oversized insertion is rejected before changing the model and smaller edits still synchronize', async () => {
		await mount(); await connect();
		const before = await browser.page.evaluate(() => window.arkdownCollaborationFixture.text(0));
		assert.equal(await browser.page.evaluate(() => { try { window.arkdownCollaborationFixture.edit(0, 0, 'x'.repeat(800 * 1024)); return false; } catch { return true; } }), true);
		assert.equal(await browser.page.evaluate(() => window.arkdownCollaborationFixture.text(0)), before);
		await browser.page.evaluate(() => window.arkdownCollaborationFixture.edit(0, 0, 'small '));
		await expect.poll(() => browser.page.evaluate(() => window.arkdownCollaborationFixture.text(1))).toContain('small ');
	});
	test('switching inputs and a second view borrow one buffer session', async () => {
		await mount(); await connect();
		await browser.page.evaluate(async () => { const f = window.arkdownCollaborationFixture; await f.show(0, 'other'); f.edit(1, 0, 'remote '); });
		await expect.poll(() => browser.page.evaluate(() => window.arkdownCollaborationFixture.text(0))).toContain('remote ');
		await browser.page.evaluate(async () => { const f = window.arkdownCollaborationFixture; await f.show(0, 'original'); await f.show(1, 'first'); });
		await expect(browser.page.locator('#a').getByRole('textbox', { name: 'Document body', exact: true })).toContainText('remote ');
		await expect(browser.page.locator('#b').getByRole('textbox', { name: 'Document body', exact: true })).toContainText('remote ');
		assert.equal(await browser.page.evaluate(() => window.arkdownCollaborationFixture.listeners), 2);
		await browser.page.evaluate(() => window.arkdownCollaborationFixture.leave(0));
		assert.equal(await browser.page.evaluate(() => window.arkdownCollaborationFixture.listeners), 1);
	});
	test('idle sessions use metadata probes and do not exchange snapshots', async () => {
		await browser.page.clock.install(); await mount(); await connect(); await browser.page.clock.runFor(100);
		const before = await browser.page.evaluate(() => window.arkdownCollaborationFixture.traffic);
		await browser.page.clock.runFor(60000);
		const after = await browser.page.evaluate(() => window.arkdownCollaborationFixture.traffic);
		assert.equal(after.refreshes, before.refreshes); assert.equal(after.submitAttempts, before.submitAttempts); assert.ok(after.probes > before.probes);
	});
	test('permanent rejection stops automatic retries and permits recovery after a new edit', async () => {
		await browser.page.clock.install(); await mount(); await connect(); await browser.page.clock.runFor(100);
		await browser.page.evaluate(() => { const f = window.arkdownCollaborationFixture; f.reject(true); f.edit(0, 0, 'local '); }); await browser.page.clock.runFor(100);
		const before = await browser.page.evaluate(() => window.arkdownCollaborationFixture.traffic.submitAttempts);
		await browser.page.clock.runFor(60000);
		assert.equal(await browser.page.evaluate(() => window.arkdownCollaborationFixture.traffic.submitAttempts), before);
		await browser.page.evaluate(() => { const f = window.arkdownCollaborationFixture; f.reject(false); f.edit(0, 0, 'recovered '); }); await browser.page.clock.runFor(100);
		await expect.poll(() => browser.page.evaluate(() => window.arkdownCollaborationFixture.text(1))).toContain('recovered local ');
	});
	test('expired receipt lease renews the transport identity without losing local edits', async () => {
		await browser.page.clock.install(); await mount(); await connect(); await browser.page.clock.runFor(100);
		await browser.page.evaluate(() => window.arkdownCollaborationFixture.expire()); await browser.page.clock.runFor(15001);
		await browser.page.evaluate(() => window.arkdownCollaborationFixture.edit(0, 0, 'renewed ')); await browser.page.clock.runFor(1000);
		await expect.poll(() => browser.page.evaluate(() => window.arkdownCollaborationFixture.text(1))).toContain('renewed ');
		assert.equal(await browser.page.evaluate(() => window.arkdownCollaborationFixture.listeners), 2);
	});
	test('offline retries respect exponential backoff while retaining unpublished edits', async () => {
		await browser.page.clock.install(); await mount(); await connect(); await browser.page.clock.runFor(100);
		await browser.page.evaluate(() => { const f = window.arkdownCollaborationFixture; f.online(false); f.edit(0, 0, 'retained '); });
		await browser.page.clock.runFor(100);
		const before = await browser.page.evaluate(() => window.arkdownCollaborationFixture.traffic);
		await browser.page.clock.runFor(7000);
		const after = await browser.page.evaluate(() => window.arkdownCollaborationFixture.traffic);
		assert.ok(after.refreshes - before.refreshes >= 3 && after.refreshes - before.refreshes <= 4);
		assert.equal(after.submitAttempts, before.submitAttempts);
		await browser.page.evaluate(() => window.arkdownCollaborationFixture.online(true));
		await browser.page.clock.runFor(10000);
		await expect.poll(() => browser.page.evaluate(() => window.arkdownCollaborationFixture.text(1))).toContain('retained ');
	});

});
