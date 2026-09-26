import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test.beforeEach(({}, testInfo) => {
	test.skip(testInfo.project.name !== 'electron-ui', 'This scenario checks the Electron UI without an App Server package.');
});

test('Electron UI opens without preparing the App Server package', async ({ workbench }) => {
	await expect(workbench.page.getByRole('button', { name: 'Application menu' })).toBeVisible();
	await expect(workbench.page.getByRole('region', { name: 'Editor', exact: true })).toBeVisible();
});
