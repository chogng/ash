import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { ExplorerFindProvider } from '../../browser/views/explorerViewer.js';
import { WorkbenchCompressibleAsyncDataTree } from '../../../../../platform/list/browser/listService.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { ExplorerItem } from '../../common/explorerModel.js';
import { FileKind } from '../../../../../platform/files/common/files.js';
import { URI } from '../../../../../base/common/uri.js';

test('Explorer find reads collapsed workspace names and cancels late results on Escape or workspace change', async () => {
	const browser = new JSDOM('<!doctype html><body><header></header><div></div></body>');
	try {
		const header = browser.window.document.querySelector('header')!;
		const host = browser.window.document.querySelector('div')!;
		const root = new ExplorerItem(URI.file('/project'), 'project', FileKind.Directory);
		const folder = new ExplorerItem(root.resource.joinPathSegment('folder'), 'folder', FileKind.Directory);
		const report = new ExplorerItem(folder.resource.joinPathSegment('report.md'), 'report.md', FileKind.File);
		let completeRead: ((children: ExplorerItem[]) => void) | undefined;
		let reads = 0;
		using config = new InMemoryConfigurationService(new ConfigurationRegistry());
		using tree = new WorkbenchCompressibleAsyncDataTree<ExplorerItem, ExplorerItem>(
			host,
			{
				hasChildren: item => item.kind === FileKind.Directory,
				getChildren: async item => {
					if (item === root) return [folder];
					if (item.resource.path === '/other') return [];
					reads++;
					return new Promise<ExplorerItem[]>(resolve => {
						completeRead = resolve;
					});
				},
			},
			{
				configurationService: config,
				compressionEnabled: false,
				findMode: 'filter',
				identityProvider: { getId: item => item.resource.toString() },
				collapseByDefault: () => true,
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel: item => item.name,
					getCompressedNodeKeyboardNavigationLabel: items => items.map(item => item.name).join('/'),
				},
				renderCompressedElements: items =>
					Object.assign(browser.window.document.createElement('span'), {
						textContent: items.map(item => item.name).join('/'),
					}),
			},
		);
		await tree.setInput(root);
		using provider = new ExplorerFindProvider(tree, header);
		const input = header.querySelector('input')!;
		const open = () =>
			tree.element.dispatchEvent(
				new browser.window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }),
			);
		const query = (value: string) => {
			input.value = value;
			input.dispatchEvent(new browser.window.Event('input', { bubbles: true }));
		};
		const escape = () =>
			input.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		open();
		assert.equal(browser.window.document.activeElement, input);
		query('report');
		await waitFor(() => completeRead !== undefined);
		completeRead!([report]);
		await waitFor(() => tree.element.textContent?.includes('report.md') === true);
		assert.equal(tree.isCollapsed(folder), true);
		escape();
		assert.equal(input.hidden, true);
		assert.equal(browser.window.document.activeElement, tree.element);
		assert.equal(tree.element.textContent?.includes('report.md'), false);
		assert.equal(reads, 1);
		// Cached collapsed children are searchable without another directory read.
		open();
		query('report');
		await waitFor(() => tree.element.textContent?.includes('report.md') === true);
		assert.equal(reads, 1);
		escape();
		await tree.setInput(root);
		completeRead = undefined;
		open();
		query('report');
		await waitFor(() => completeRead !== undefined);
		escape();
		completeRead!([report]);
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(input.hidden, true);
		assert.equal(tree.element.textContent?.includes('report.md'), false);
		await tree.setInput(root);
		completeRead = undefined;
		open();
		query('report');
		await waitFor(() => completeRead !== undefined);
		const replacement = new ExplorerItem(URI.file('/other'), 'other', FileKind.Directory);
		const change = tree.setInput(replacement);
		completeRead!([]);
		await change;
		assert.equal(input.hidden, true);
		assert.equal(input.value, '');
	} finally {
		browser.window.close();
	}
});

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	assert.fail('Timed out waiting for Explorer find');
}
