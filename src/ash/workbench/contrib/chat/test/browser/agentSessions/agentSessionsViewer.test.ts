import assert from 'node:assert/strict';
import { suite, test, teardown } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../../test/unit/browser/context.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { URI } from '../../../../../../base/common/uri.js';
import { LocalSelectionTransfer } from '../../../../../../platform/dnd/browser/dnd.js';
import { DraggedEditorIdentifier } from '../../../../../browser/parts/editor/editorTabDragAndDrop.js';
import { ChatEditorInput } from '../../../browser/widgetHosts/editor/chatEditorInput.js';
import type { IAgentSession } from '../../../browser/agentSessions/agentSessionsModel.js';
import { AgentSessionsDragAndDrop } from '../../../browser/agentSessions/agentSessionsViewer.js';
import type { TreeDragData } from '../../../../../../base/browser/ui/tree/tree.js';

function session(getEditorInput?: IAgentSession['getEditorInput']): IAgentSession {
	return {
		id: 'draft', resource: URI.from({ scheme: 'test-session', path: '/draft' }), label: 'Draft',
		description: '', kind: 'draft', target: { untitledSessionId: 'draft' }, active: true,
		isArchived: () => false, isPinned: () => false, open() { }, getEditorInput,
	};
}

function data(item: IAgentSession): TreeDragData<IAgentSession> {
	return { kind: 'internal', elements: [item], types: [], files: [] };
}

suite('Agent Sessions editor drag lifetime', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const transfer = LocalSelectionTransfer.getInstance<DraggedEditorIdentifier>();

	test('URI discovery borrows no input and only editor-backed sessions can start a drag', () => {
		using source = new AgentSessionsDragAndDrop();
		let allocations = 0;
		const item = session(() => { allocations++; return { resource: URI.from({ scheme: 'test-editor', path: '/draft' }) }; });
		assert.equal(source.getDragURI(item), item.resource.toString());
		assert.equal(source.getDragURI(session()), undefined);
		assert.equal(source.getDragURI({ kind: 'section', id: 'drafts', label: 'Drafts', items: [item] }), undefined);
		assert.equal(allocations, 0);
		assert.equal(source.onDragOver(), false);
	});

	test('a replacement drag and cancellation release the previous temporary input', () => {
		using source = new AgentSessionsDragAndDrop();
		using first = new ChatEditorInput('untitled:first');
		using second = new ChatEditorInput('untitled:second');
		const event = { dataTransfer: { effectAllowed: 'none' } } as DragEvent;
		source.onDragStart(data(session(() => first)), event);
		assert.equal(event.dataTransfer?.effectAllowed, 'move');
		assert.equal(transfer.getData(DraggedEditorIdentifier.prototype)?.[0]?.input, first);
		source.onDragStart(data(session(() => second)), event);
		assert.equal(first.isDisposed, true);
		assert.equal(second.isDisposed, false);
		source.onDragEnd();
		assert.equal(second.isDisposed, true);
		assert.equal(transfer.getData(DraggedEditorIdentifier.prototype), undefined);
	});

	test('source disposal releases an unconsumed drag but preserves an input taken by the editor', () => {
		using source = new AgentSessionsDragAndDrop();
		using abandoned = new ChatEditorInput('untitled:abandoned');
		source.onDragStart(data(session(() => abandoned)), {} as DragEvent);
		source.dispose();
		assert.equal(abandoned.isDisposed, true);
		assert.equal(transfer.getData(DraggedEditorIdentifier.prototype), undefined);

		using consumedSource = new AgentSessionsDragAndDrop();
		using retained = new ChatEditorInput('untitled:retained');
		consumedSource.onDragStart(data(session(() => retained)), {} as DragEvent);
		// The editor drop consumes this same transfer before ending the source drag.
		transfer.clearData(DraggedEditorIdentifier.prototype);
		consumedSource.dispose();
		assert.equal(retained.isDisposed, false);
	});
});

suite('Agent Sessions row descriptions', () => {
	const browser = useBrowserTests();
	teardown(async () => { await browser.page.evaluate(() => window.agentSessionsFixture?.dispose()); });
	for (const locale of ['en', 'zh-CN'] as const) {
		test(`visible, accessible and search labels agree for an untitled draft (${locale})`, async () => {
			const { page } = browser;
			await page.goto(`/agentSessions.html?locale=${locale}`);
			await page.evaluate(async () => { await window.agentSessionsFixture.ready(); await window.agentSessionsFixture.blankDraft(); });
			const label = locale === 'en' ? 'New Session' : '新建会话';
			const description = locale === 'en' ? 'Draft' : '草稿';
			const row = page.getByRole('treeitem', { name: locale === 'en' ? `${label}, ${description}` : `${label}，${description}`, exact: true });
			await expect(row.locator('.ash-agent-session-title')).toHaveText(label);
			await expect(row.locator('.ash-agent-session-description')).toHaveText(description);
			const tree = page.getByRole('tree');
			if (locale === 'en') {
				await tree.focus();
				await tree.press('End');
				await tree.press('n');
				await expect(row).toHaveClass(/focused/u);
			}
			const search = page.getByRole('searchbox');
			await search.fill(label);
			await expect(page.getByRole('tree').locator('[data-item]')).toHaveCount(1);
			await search.press('ArrowDown');
			await tree.press('Enter');
			await expect.poll(() => page.evaluate(() => window.agentSessionsFixture.opened)).toEqual(['session-0']);
		});
	}
});
