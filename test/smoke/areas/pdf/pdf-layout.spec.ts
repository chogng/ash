import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';

test.use({ electronArgs: ['--agents-window'], electronUserSettings: { 'sessions.pdf.scrollMode': 'paged' }, useDefaultLanguageServer: false });

test('PDF sidebar widths survive closing the tab and restarting Ash', { tag: ['@electron-app-server'] }, async ({ application, workbench, testWorkspace, runningApplication }) => {
	const preview = () => workbench.page.locator('.ash-sessions-pdf-preview:visible');
	const controls = () => workbench.page.locator('.ash-editor-group').filter({ has: preview() }).locator('.ash-editor-group-header > .ash-editor-pane-toolbar-host > .ash-sessions-pdf-controls');
	const left = () => preview().getByRole('complementary', { name: 'PDF page navigation', exact: true });
	const right = () => preview().getByRole('complementary', { name: 'PDF annotations', exact: true });
	const leftDivider = () => preview().getByRole('separator', { name: 'Resize PDF page navigation', exact: true });
	const rightDivider = () => preview().getByRole('separator', { name: 'Resize PDF reading area and annotations', exact: true });
	const openPdf = async () => {
		if (!('windows' in application)) throw new Error('PDF layout persistence requires Desktop');
		const dialog = await application.evaluateHandle(({ dialog }) => dialog.showOpenDialog);
		try {
			await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, testWorkspace.pdfFile);
			await workbench.quickaccess.runCommand('workbench.action.files.openFile');
			await expect(preview().getByRole('status')).toHaveText('Page 1 of 1');
		} finally {
			await application.evaluate(({ dialog }, original) => { dialog.showOpenDialog = original; }, dialog);
			await dialog.dispose();
		}
		const navigation = controls().getByRole('button', { name: 'PDF page navigation', exact: true });
		const comments = controls().getByRole('button', { name: 'PDF comments', exact: true });
		await expect(navigation).toHaveAttribute('aria-expanded', 'false');
		await expect(comments).toHaveAttribute('aria-expanded', 'false');
		await expect(left()).toBeHidden();
		await expect(right()).toBeHidden();
		await navigation.click();
		await expect(left()).toBeVisible();
		await expect(right()).toBeHidden();
		await comments.click();
		await expect(right()).toBeVisible();
	};
	const closePdf = async () => {
		await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
		await expect(preview()).toHaveCount(0);
	};
	const expectWidths = async (navigation: number, annotations: number) => {
		await expect(left()).toHaveCSS('width', `${navigation}px`);
		await expect(right()).toHaveCSS('width', `${annotations}px`);
	};

	await test.step('Restore both adjusted widths after closing the PDF tab', async () => {
		await openPdf();
		await expectWidths(160, 220);
		await dragDivider(workbench.page, leftDivider(), -30);
		await dragDivider(workbench.page, rightDivider(), 40);
		await expectWidths(130, 180);
		await closePdf();
		await openPdf();
		await expectWidths(130, 180);
	});

	await test.step('Restore both widths after quitting and starting Ash again', async () => {
		await closePdf();
		({ application, workbench } = await runningApplication.reload('quit'));
		await openPdf();
		await expectWidths(130, 180);
	});

	await test.step('Persist a reset for each side independently', async () => {
		await leftDivider().dblclick();
		await expectWidths(160, 180);
		await closePdf();
		({ application, workbench } = await runningApplication.reload('quit'));
		await openPdf();
		await expectWidths(160, 180);
		await rightDivider().dblclick();
		await expectWidths(160, 220);
		await closePdf();
		await openPdf();
		await expectWidths(160, 220);
	});
});

async function dragDivider(page: Page, divider: Locator, delta: number): Promise<void> {
	const bounds = (await divider.boundingBox())!;
	const x = bounds.x + bounds.width / 2;
	const y = bounds.y + bounds.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + delta, y, { steps: 5 });
	await page.mouse.up();
}
