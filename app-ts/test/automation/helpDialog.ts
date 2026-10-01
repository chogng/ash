import { expect, type Page } from '@playwright/test';
import type { BrowserWindow, MessageBoxOptions } from 'electron';
import type { PlaywrightApplication } from './playwrightDriver.js';

interface PendingHelpDialog {
	options?: MessageBoxOptions;
	finish?: () => void;
	restore(): void;
}

/** Exercises the dialog owner used by the current host before returning focus to the caller. */
export async function expectHelpDialog(application: PlaywrightApplication, page: Page, title: string, open: () => Promise<void>): Promise<void> {
	if (!('windows' in application)) {
		await open();
		const dialog = page.getByRole('dialog', { name: title, exact: true });
		await expect(dialog).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		return;
	}

	await application.evaluate(({ dialog }) => {
		const original = dialog.showMessageBox.bind(dialog);
		const state = globalThis as typeof globalThis & { ashTestHelpDialog?: PendingHelpDialog };
		state.ashTestHelpDialog = { restore: () => { dialog.showMessageBox = original; } };
		dialog.showMessageBox = ((...args: [MessageBoxOptions] | [BrowserWindow, MessageBoxOptions]) => new Promise(resolve => {
			state.ashTestHelpDialog!.options = args.length === 1 ? args[0] : args[1];
			state.ashTestHelpDialog!.finish = () => resolve({ response: 0, checkboxChecked: false });
		})) as typeof dialog.showMessageBox;
	});
	try {
		await open();
		await expect.poll(() => application.evaluate(() => (globalThis as typeof globalThis & { ashTestHelpDialog?: PendingHelpDialog }).ashTestHelpDialog?.options?.title)).toBe(title);
		await application.evaluate(() => (globalThis as typeof globalThis & { ashTestHelpDialog?: PendingHelpDialog }).ashTestHelpDialog?.finish?.());
	} finally {
		await application.evaluate(() => {
			const state = globalThis as typeof globalThis & { ashTestHelpDialog?: PendingHelpDialog };
			state.ashTestHelpDialog?.finish?.();
			state.ashTestHelpDialog?.restore();
			delete state.ashTestHelpDialog;
		});
	}
}
