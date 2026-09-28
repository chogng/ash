import { expect, test } from '../../../automation/test.js';

test.use({ gitRepository: true });

test('SCM history shows Git commits and opens a changed file', async ({ target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires a desktop App Server workspace.');

	const page = workbench.page;
	await page.getByRole('tab', { name: 'Git', exact: true }).click();
	const history = page.locator('[data-view-id="ash.gitGraph"]');
	await expect(history).toBeVisible();
	await history.locator('.ash-pane-view-header').click();
	const commit = history.getByRole('treeitem', { name: /Initial/ });
	await expect(commit).toBeVisible();
	await expect(commit).toHaveAttribute('aria-current', 'true');
	await commit.click();
	const changedFile = commit.getByRole('button', { name: /main\.ts/ });
	await expect(changedFile).toBeVisible();
	await changedFile.click();
	await expect(workbench.editors.groupAt(0).tabs.first()).toContainText('main.ts');
});

test('SCM history pane opens without a connected repository', async ({ target, workbench }) => {
	test.skip(target.kind === 'electron' && target.appServerMode === 'required', 'Checks disconnected Workbench hosts.');

	const page = workbench.page;
	await page.getByRole('tab', { name: 'Git', exact: true }).click();
	const changes = page.locator('[data-view-id="ash.gitView"]');
	await expect(changes.locator('.ash-scm-status')).toContainText('source control');
	const history = page.locator('[data-view-id="ash.gitGraph"]');
	await expect(history).toBeVisible();
	await history.locator('.ash-pane-view-header').click();
	await expect(history.locator('.ash-scm-empty')).toContainText('No commits yet.');
});
