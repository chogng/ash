import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../test/unit/browser/context.js';

suite('treeView browser component', () => {
	const browserTests = useBrowserTests();
	for (const variant of ['', '?dark', '?hc&locale=zh-CN']) {
		test(`extension tree reads, checks, renames, refreshes and remounts ${variant || 'light'}`, async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });
			await page.goto(`/treeView.html${variant}`);
			try {
				const root = page.getByRole('treeitem').filter({ hasText: 'Root' });
				await expect(root).toBeVisible();
				await root.click();
				await page.keyboard.press('ArrowRight');
				const child = page.getByRole('treeitem').filter({ hasText: 'Child' });
				await expect(child).toBeVisible();
				const checkbox = child.getByRole('checkbox');
				await checkbox.focus();
				await page.keyboard.press('Space');
				await expect.poll(() => page.evaluate(() => window.treeIntegration.requests().some(request => (request.payload as any).method === 'checkbox' && (request.payload as any).isChecked))).toBe(true);
				await expect(checkbox).toBeChecked();
				expect(await page.evaluate(() => window.treeIntegration.commands())).toEqual([]);
				await child.click();
				await page.keyboard.press('F2');
				const rename = page.getByRole('textbox', { name: variant.includes('zh-CN') ? '重命名 Child' : 'Rename Child' });
				await expect(rename).toBeFocused();
				expect(await rename.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([0, 5]);
				await rename.fill('Renamed');
				await rename.press('Enter');
				await expect(page.locator('.ash-custom-tree-label').filter({ hasText: /^Renamed$/ })).toBeVisible();
				await page.keyboard.press('F2');
				const cancel = page.getByRole('textbox');
				await cancel.fill('Cancelled');
				await cancel.press('Escape');
				await expect(cancel).toHaveCount(0);
				expect(await page.evaluate(() => window.treeIntegration.requests().filter(request => (request.payload as any).method === 'rename').map(request => (request.payload as any).value))).toEqual(['Renamed']);
				const tree = page.getByRole('tree');
				await tree.focus();
				expect(await page.evaluate(() => window.treeIntegration.accessible(false))).toContain('Renamed: Provider owned');
				expect(await page.evaluate(() => window.treeIntegration.accessible(true))).toContain('F2');
				await expect(tree).toBeFocused();
				await expect(tree).toHaveAttribute('aria-description', /F2/);
				await page.evaluate(() => window.treeIntegration.verbosity(false));
				await page.locator('#outside').focus();
				await tree.focus();
				await expect(tree).not.toHaveAttribute('aria-description');
				const geometry = await page.locator('.ash-custom-tree-row').last().evaluate(row => {
					const text = row.querySelector('.ash-custom-tree-label')!;
					return { overflow: getComputedStyle(text).textOverflow, height: row.getBoundingClientRect().height, width: row.getBoundingClientRect().width };
				});
				expect(geometry.overflow).toBe('ellipsis');
				expect(geometry.height).toBeGreaterThan(0);
				expect(geometry.width).toBeGreaterThan(0);
				await page.keyboard.press('F2');
				await page.getByRole('textbox').fill('Unsubmitted');
				await page.evaluate(() => window.treeIntegration.refresh('From provider'));
				await expect(page.getByRole('textbox')).toHaveValue('Unsubmitted');
				await page.getByRole('textbox').press('Escape');
				await expect(page.getByRole('textbox')).toHaveCount(0);
				expect(await page.evaluate(() => window.treeIntegration.requests().filter(request => (request.payload as any).method === 'rename').length)).toBe(1);
				await expect(page.locator('.ash-custom-tree-label').filter({ hasText: /^From provider$/ })).toBeVisible();
				await page.evaluate(() => window.treeIntegration.move());
				await expect(page.locator('#first .ash-custom-tree-view')).toHaveCount(0);
				await expect(page.locator('#second .ash-custom-tree-view')).toBeVisible();
				await expect(page.getByRole('treeitem').filter({ hasText: 'Root' })).toHaveAttribute('aria-expanded', 'true');
				await expect(page.getByRole('treeitem').filter({ hasText: 'From provider' })).toHaveAttribute('aria-selected', 'true');
				await expect(page.locator('#second .ash-custom-tree-label').filter({ hasText: /^From provider$/ })).toBeVisible();
				expect(errors).toEqual([]);
			} finally { await page.evaluate(() => window.treeIntegration?.dispose()); }
		});
	}

	test('provider controls reveal unloaded descendants and retain selection across a multiselect remount', async function () {
		const { page } = browserTests;
		await page.goto('/treeView.html?rich');
		try {
			await expect(page.getByRole('treeitem')).toHaveCount(1);
			await page.evaluate(() => window.treeIntegration.operation('reveal', ['root', 'child'], { focus: true }));
			const child = page.getByRole('treeitem', { name: 'Provider child', exact: true });
			await expect(child).toHaveAttribute('aria-selected', 'true');
			await expect(child.locator('.ash-icon-label-highlight')).toHaveText('Ch');
			await expect(child.locator('.ash-icon-file')).toHaveCount(1);
			await child.locator('.ash-custom-tree-label').hover();
			await expect(page.locator('.ash-hover strong')).toHaveText('Provider');
			await page.keyboard.press('Escape');
			await page.evaluate(() => window.treeIntegration.operation('configure', undefined, { title: 'Changed title', description: 'Changed description', message: 'Provider message', badge: { value: 3, tooltip: 'Three pending items' }, canSelectMany: true, showCollapseAllAction: true }));
			await expect(child).toHaveAttribute('aria-selected', 'true');
			await expect(page.getByRole('tree')).toHaveAttribute('aria-label', 'Changed title');
			await expect(page.locator('.ash-view-pane-header-description')).toHaveText('Changed description');
			await expect(page.locator('.ash-custom-tree-badge')).toHaveText('3');
			await expect(page.locator('.ash-custom-tree-status')).toHaveText('Provider message');
			await page.evaluate(() => window.treeIntegration.operation('select', ['root', 'child']));
			await expect(page.locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(2);
			await page.evaluate(() => window.treeIntegration.operation('reveal', ['root'], { focus: true }));
			await page.keyboard.press('Shift+ArrowDown');
			await expect(page.locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(2);
			await page.evaluate(() => window.treeIntegration.operation('collapseAll', []));
			await expect(page.getByRole('treeitem').filter({ hasText: 'Root' })).toHaveAttribute('aria-expanded', 'false');
		} finally { await page.evaluate(() => window.treeIntegration.dispose()); }
	});

	for (const dark of [false, true]) {
		test(`custom ${dark ? 'dark' : 'light'} icons load through the file owner`, async function () {
			const { page } = browserTests;
			await page.goto(`/treeView.html?customIcons${dark ? '&dark' : ''}`);
			try {
				await expect(page.getByRole('treeitem')).toBeVisible();
				await page.evaluate(() => window.treeIntegration.operation('reveal', ['root', 'child']));
				const icon = page.locator('.ash-custom-tree-content img');
				await expect(icon).toHaveAttribute('src', /^blob:/);
				await expect.poll(() => icon.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(16);
				expect(await page.evaluate(() => window.treeIntegration.iconReads().at(-1))).toBe(`/fixture/${dark ? 'dark' : 'light'}.svg`);
			} finally { await page.evaluate(() => window.treeIntegration.dispose()); }
		});
	}

	test('element changes only read the parent branch and focus-only changes notify the provider', async function () {
		const { page } = browserTests;
		await page.goto('/treeView.html');
		try {
			await expect(page.getByRole('treeitem')).toBeVisible();
			await page.evaluate(() => window.treeIntegration.operation('reveal', ['root', 'child'], { focus: true }));
			const before = await page.evaluate(() => window.treeIntegration.requests().length);
			await page.evaluate(() => window.treeIntegration.refresh('Changed child', 'child'));
			await expect(page.locator('.ash-custom-tree-label').filter({ hasText: /^Changed child$/ })).toBeVisible();
			expect(await page.evaluate(before => window.treeIntegration.requests().slice(before).filter(request => (request.payload as any).method === 'children').map(request => (request.payload as any).handle), before)).toEqual(['root']);
			await page.evaluate(() => window.treeIntegration.operation('reveal', ['root'], { select: false, focus: true }));
			await expect.poll(() => page.evaluate(() => window.treeIntegration.requests().filter(request => (request.payload as any).method === 'selection').at(-1)?.payload)).toEqual({ method: 'selection', handles: ['child'], handle: 'root' });
		} finally { await page.evaluate(() => window.treeIntegration.dispose()); }
	});

	test('node contexts enable inline and keyboard menu actions without opening the item', async function () {
		const { page } = browserTests;
		await page.goto('/treeView.html?rich');
		try {
			await expect(page.getByRole('treeitem')).toBeVisible();
			await page.evaluate(() => window.treeIntegration.operation('reveal', ['root', 'child'], { focus: true }));
			const geometry = await page.locator('[data-tree-handle="child"]').evaluate(row => ({ row: row.getBoundingClientRect().height, action: row.querySelector('button')!.getBoundingClientRect().height }));
			expect(geometry).toEqual({ row: 22, action: 22 });
			await page.getByRole('button', { name: 'Inspect item', exact: true }).click();
			expect(await page.evaluate(() => window.treeIntegration.commands())).toEqual([['test.inspect', { viewId: 'test.tree', handle: 'child' }]]);
			await page.getByRole('tree').focus();
			await page.keyboard.press('Shift+F10');
			await page.getByRole('menuitem', { name: 'More item actions', exact: true }).click();
			expect(await page.evaluate(() => window.treeIntegration.commands())).toEqual([['test.inspect', { viewId: 'test.tree', handle: 'child' }], ['test.more', { viewId: 'test.tree', handle: 'child' }]]);
			await expect(page.getByRole('tree')).toBeFocused();
		} finally { await page.evaluate(() => window.treeIntegration.dispose()); }
	});

	test('native drag and drop delivers the asynchronous provider payload to the target', async function () {
		const { page } = browserTests;
		await page.goto('/treeView.html');
		try {
			await expect(page.getByRole('treeitem')).toBeVisible();
			await page.evaluate(() => window.treeIntegration.operation('reveal', ['root', 'child']));
			await page.evaluate(() => window.treeIntegration.operation('configure', undefined, { dragMimeTypes: ['text/plain'], dropMimeTypes: ['text/plain'] }));
			await page.getByRole('treeitem').filter({ hasText: 'Child' }).dragTo(page.getByRole('treeitem').filter({ hasText: 'Root' }));
			await expect.poll(() => page.evaluate(() => window.treeIntegration.requests().find(request => (request.payload as any).method === 'drop')?.payload)).toEqual({ method: 'drop', handle: 'root', data: { 'text/plain': 'Dragged child' } });
		} finally { await page.evaluate(() => window.treeIntegration.dispose()); }
	});

	test('tree controls reject malformed options and missing nodes', async function () {
		const { page } = browserTests;
		await page.goto('/treeView.html');
		try {
			await expect(page.getByRole('treeitem')).toBeVisible();
			const errors = await page.evaluate(async () => {
				const failures: string[] = [];
				for (const [action, handles, options] of [['configure', undefined, { badge: { value: -1, tooltip: 'invalid' } }], ['select', ['missing'], undefined], ['configure', undefined, { dragMimeTypes: ['invalid'] }]] as const) {
					try { await window.treeIntegration.operation(action, handles ? [...handles] : undefined, options); }
					catch (error) { failures.push(String(error)); }
				}
				return failures;
			});
			expect(errors).toEqual(['TypeError: Invalid tree badge', 'Error: Unknown tree item: missing', 'TypeError: Invalid tree MIME types']);
		} finally { await page.evaluate(() => window.treeIntegration.dispose()); }
	});

	test('provider messages suppress welcome content and remounts retain the pane-owned welcome region', async function () {
		const { page } = browserTests;
		await page.goto('/treeView.html?empty');
		try {
			await expect(page.getByText('Provider welcome', { exact: true })).toBeVisible();
			await page.evaluate(() => window.treeIntegration.operation('configure', undefined, { message: 'Provider explanation' }));
			await expect(page.getByText('Provider welcome', { exact: true })).toBeHidden();
			await expect(page.getByText('Provider explanation', { exact: true })).toBeVisible();
			await page.evaluate(() => window.treeIntegration.operation('configure', undefined, { message: '', canSelectMany: true }));
			await expect(page.getByText('Provider welcome', { exact: true })).toBeVisible();
			await expect(page.locator('.ash-view-welcome')).toHaveCount(1);
		} finally { await page.evaluate(() => window.treeIntegration.dispose()); }
	});

	test('retiring an extension tree aborts reads and rejects old refresh identities', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/treeView.html');
		await expect(page.getByRole('treeitem')).toBeVisible();
		const reads = await page.evaluate(() => window.treeIntegration.requests().length);
		await page.evaluate(() => window.treeIntegration.block());
		await expect.poll(() => page.evaluate(() => window.treeIntegration.requests().length)).toBeGreaterThan(reads);
		await page.evaluate(() => window.treeIntegration.stop());
		await expect(page.getByRole('tree')).toHaveCount(0);
		expect(await page.evaluate(() => window.treeIntegration.aborted())).toBe(true);
		expect(await page.evaluate(() => window.treeIntegration.stale())).toBe(true);
		await page.evaluate(() => window.treeIntegration.release());
		await expect(page.getByText('Retired result')).toHaveCount(0);
		await page.evaluate(() => window.treeIntegration.dispose());
		expect(errors).toEqual([]);
	});
});
