import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('Arkdown document comments', () => {
	const browser = useBrowserTests();
	const mount = async (source: string) => {
		await browser.page.goto('/arkdown.html');
		await expect(browser.page.locator('body')).toHaveAttribute('data-ready', 'true');
		await browser.page.evaluate(source => window.arkdownFixture.mount(source), source);
	};
	const select = async (selector = 'strong') => {
		await browser.page.getByRole('textbox', { name: 'Document body', exact: true }).locator(selector).first().evaluate(element => {
			const range = element.ownerDocument.createRange(); range.selectNodeContents(element);
			const selection = element.ownerDocument.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
		});
	};
	const create = async (body = 'Review this wording') => browser.page.evaluate(body => window.arkdownFixture.createComment(body, window.arkdownFixture.captureComment()), body);

	test('anchored Unicode comments preserve formatting, selection, persistence and atomic undo', async () => {
		const original = 'Before **中文🙂 words** after';
		await mount(original); await select();
		const id = await create();
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await expect(body.locator(`[data-comment-id="${id}"]`)).toHaveText('中文🙂 words');
		assert.equal(await browser.page.evaluate(() => window.getSelection()?.toString()), '中文🙂 words');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.plainText), 'Before 中文🙂 words after');
		assert.equal(await body.locator('pre').count(), 0);
		const saved = await browser.page.evaluate(() => window.arkdownFixture.source);
		await browser.page.evaluate(() => window.arkdownFixture.undo());
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), original);
		await browser.page.evaluate(() => window.arkdownFixture.redo());
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), saved);
		await browser.page.evaluate(() => { window.arkdownFixture.mode('markdown'); window.arkdownFixture.mode('rich'); });
		await expect(body.locator('strong')).toHaveText('中文🙂 words');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.commentState.threads[0].messages[0].body), 'Review this wording');
		assert.deepEqual(await browser.page.evaluate(() => window.arkdownFixture.errors), []);
	});

	test('reply, edit, resolve, reopen and deletion share the existing document history', async () => {
		await mount('Read **selected** text'); await select(); const id = await create();
		await browser.page.evaluate(id => window.arkdownFixture.replyComment(id, 'A reply'), id);
		const messageId = await browser.page.evaluate(() => window.arkdownFixture.commentState.threads[0].messages[1].id);
		await browser.page.evaluate(({ id, messageId }) => window.arkdownFixture.editComment(id, messageId, 'Edited reply'), { id, messageId });
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.commentState.threads[0].messages[1].body), 'Edited reply');
		await browser.page.evaluate(id => window.arkdownFixture.resolveComment(id, true), id);
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.commentState.threads[0].state), 'resolved');
		await browser.page.evaluate(() => window.arkdownFixture.undo());
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.commentState.threads[0].state), 'open');
		await browser.page.evaluate(id => { window.arkdownFixture.resolveComment(id, true); window.arkdownFixture.resolveComment(id, false); }, id);
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.commentState.threads[0].state), 'open');
		const saved = await browser.page.evaluate(() => window.arkdownFixture.source);
		await browser.page.evaluate(id => window.arkdownFixture.deleteComment(id), id);
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.commentState.threads.length), 0);
		await expect(browser.page.locator('[data-comment-id]')).toHaveCount(0);
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.plainText), 'Read selected text');
		await browser.page.evaluate(() => window.arkdownFixture.undo());
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), saved);
	});

	test('overlapping comments retain other anchors and formatting when one thread is deleted', async () => {
		await mount('Read **selected** text'); await select(); const first = await create('First');
		await select(); const second = await create('Second');
		await browser.page.evaluate(() => { window.arkdownFixture.setTextColor('purple'); window.arkdownFixture.toggleUnderline(); });
		await browser.page.evaluate(id => window.arkdownFixture.deleteComment(id), first);
		const state = await browser.page.evaluate(() => window.arkdownFixture.commentState);
		assert.equal(state.threads.length, 1); assert.equal(state.threads[0].id, second);
		await expect(browser.page.locator(`[data-comment-id="${second}"]`)).toHaveText('selected');
		await expect(browser.page.locator('strong')).toHaveText('selected');
		await expect(browser.page.locator('.ash-arkdown-text-purple')).toHaveText('selected');
		await expect(browser.page.locator('u')).toHaveText('selected');
	});

	test('switching documents releases old threads and drafts after the old editor is disposed', async () => {
		await mount('First **selection**'); await select(); await create('First document only');
		await browser.page.evaluate(() => window.arkdownFixture.showComments());
		const panel = browser.page.getByRole('complementary', { name: 'Comments', exact: true });
		await expect(panel.locator('.ash-docs-comment-body')).toHaveText('First document only');
		await browser.page.evaluate(() => window.arkdownFixture.switchDocument('Second document'));
		await expect(panel).toBeHidden();
		await browser.page.evaluate(() => window.arkdownFixture.showComments());
		await expect(panel.getByText('No comments', { exact: true })).toBeVisible();
		await expect(panel.locator('.ash-docs-comment-body')).toHaveCount(0);
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), 'Second document');
		assert.deepEqual(await browser.page.evaluate(() => window.arkdownFixture.errors), []);
	});

	test('anchors move with source edits and detached threads retain their original quote', async () => {
		await mount('Before **selected** after'); await select(); const id = await create();
		await browser.page.evaluate(() => window.arkdownFixture.external('A new paragraph\n\n' + window.arkdownFixture.source));
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.commentState.anchors[0][1].quote), 'selected');
		await browser.page.evaluate(id => {
			const source = window.arkdownFixture.source, start = source.indexOf(`<span data-comment-id="${id}">`), end = source.indexOf('</span>', start) + '</span>'.length;
			window.arkdownFixture.external(source.slice(0, start) + source.slice(end));
		}, id);
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.commentState.anchors.length), 0);
		await browser.page.evaluate(() => window.arkdownFixture.showComments());
		await expect(browser.page.getByText('Original text removed', { exact: true })).toBeVisible();
		await expect(browser.page.getByText('Review this wording', { exact: true })).toBeVisible();
	});

	test('stale drafts, read-only edits and malformed storage cannot mutate comments', async () => {
		await mount('Read **selected** text'); await select();
		const stale = await browser.page.evaluate(() => {
			const draft = window.arkdownFixture.captureComment(); window.arkdownFixture.external('Changed\n\n' + window.arkdownFixture.source);
			try { window.arkdownFixture.createComment('Stale', draft); return false; } catch { return true; }
		});
		assert.equal(stale, true);
		const blocked = await browser.page.evaluate(() => {
			window.arkdownFixture.readOnly(true); const source = window.arkdownFixture.source;
			try { window.arkdownFixture.createComment('Blocked'); return false; } catch { return source === window.arkdownFixture.source; }
		});
		assert.equal(blocked, true);
		await mount('Text\n\n```ash-comments\n{broken}\n```\n');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.commentState.invalid), true);
		await expect(browser.page.locator('pre')).toContainText('{broken}');
		assert.equal(await browser.page.evaluate(() => { try { window.arkdownFixture.createComment('Blocked'); return false; } catch { return true; } }), true);
	});

	test('concurrent replies converge through the real Rust CRDT without replacing another reply', async () => {
		await mount('Text');
		const result = await browser.page.evaluate(() => window.arkdownFixture.concurrentCommentReplies());
		assert.equal(result.converged, true); assert.equal(result.invalid, false);
		assert.deepEqual(result.messages?.slice().sort(), ['Concurrent left', 'Concurrent right', 'Initial comment']);
	});

	test('a document comment in an empty file leaves a writable body before its metadata', async () => {
		await mount(''); await browser.page.evaluate(() => window.arkdownFixture.createComment('Document review'));
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await body.locator('p').click(); await body.pressSequentially('New document text');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.plainText), 'New document text');
		const state = await browser.page.evaluate(() => window.arkdownFixture.commentState);
		assert.equal(state.invalid, false); assert.equal(state.anchors.length, 0);
		assert.equal(state.threads[0].messages[0].body, 'Document review');
	});

	test('read-only threads remain readable while all mutation controls are disabled', async () => {
		await mount('Read **selection**'); await select(); await create('A readable comment');
		await browser.page.evaluate(() => { window.arkdownFixture.readOnly(true); window.arkdownFixture.showComments(); });
		const panel = browser.page.getByRole('complementary', { name: 'Comments', exact: true });
		await expect(panel.locator('.ash-docs-comment-body')).toHaveText('A readable comment');
		await expect(panel.getByRole('button', { name: 'New comment', exact: true })).toBeDisabled();
		await expect(panel.getByRole('button', { name: 'Resolve thread', exact: true })).toBeDisabled();
		await expect(panel.getByRole('button', { name: 'Delete thread', exact: true })).toBeDisabled();
		await expect(panel.getByRole('button', { name: 'Edit comment', exact: true })).toHaveCount(0);
	});

	test('the selection composer retains drafts and shares the sidebar comment workflow', async () => {
		await mount('Review **selected** text');
		await browser.page.evaluate(() => window.arkdownFixture.showComments());
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		const panel = browser.page.getByRole('complementary', { name: 'Comments', exact: true });
		await panel.getByRole('button', { name: 'Close comments', exact: true }).click();
		await select();
		const anchor = await browser.page.evaluate(() => window.arkdownFixture.selectionBounds);
		await body.press('ControlOrMeta+Alt+m');
		const popup = browser.page.getByRole('dialog', { name: 'Add comment', exact: true });
		const floatingInput = popup.getByRole('textbox', { name: 'Comment text', exact: true });
		await expect(floatingInput).toBeFocused();
		await expect(panel).toBeHidden();
		const bounds = await popup.boundingBox();
		assert.ok(anchor && bounds && (bounds.x >= anchor.right || bounds.x + bounds.width <= anchor.left));
		await floatingInput.fill('<script>Review safely</script>');
		await floatingInput.press('Escape');
		await expect(popup).toBeHidden();
		await expect(body).toBeFocused();
		await body.press('ControlOrMeta+Alt+m');
		await expect(floatingInput).toHaveValue('<script>Review safely</script>');
		await floatingInput.press('Enter');
		await expect(popup).toBeHidden();
		const input = panel.getByRole('textbox', { name: 'Comment text', exact: true });
		await expect(input).toBeFocused();
		await expect(panel.locator('.ash-docs-comment-body')).toHaveText('<script>Review safely</script>');
		await expect(panel.locator('script')).toHaveCount(0);
		await input.fill('Reply line one'); await input.press('Shift+Enter'); await input.pressSequentially('line two'); await input.press('Enter');
		await expect(panel.locator('.ash-docs-comment-body')).toHaveText(['<script>Review safely</script>', 'Reply line one\nline two']);
		await panel.getByRole('button', { name: 'Edit comment', exact: true }).last().click(); await input.fill('Edited reply');
		await panel.getByRole('button', { name: 'Save comment', exact: true }).click();
		await expect(panel.locator('.ash-docs-comment-body').last()).toHaveText('Edited reply');
		await input.fill('Unsent draft'); await input.press('Escape'); await expect(panel).toBeHidden();
		await browser.page.evaluate(() => window.arkdownFixture.showComments()); await expect(input).toHaveValue('Unsent draft');
		await panel.getByRole('button', { name: 'Resolve thread', exact: true }).click();
		await expect(panel.locator('.ash-docs-comment-thread')).toHaveCount(0);
		await panel.getByRole('combobox', { name: 'Filter comments', exact: true }).click();
		await browser.page.getByRole('option', { name: 'Resolved comments', exact: true }).click();
		await expect(panel.getByText('Thread resolved', { exact: true })).toBeVisible();
		await panel.getByRole('button', { name: 'Reopen thread', exact: true }).click();
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.commentState.threads[0].state), 'open');
		assert.deepEqual(await browser.page.evaluate(() => window.arkdownFixture.errors), []);
	});
});
