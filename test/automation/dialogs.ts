import { expect, type Page } from '@playwright/test';
import type { BrowserWindow, MessageBoxOptions } from 'electron';
import type { PlaywrightApplication } from './playwrightDriver.js';

export interface DialogMessage {
	readonly title: string;
	readonly message: string;
	readonly detail: string;
	readonly buttons: readonly string[];
}

interface DialogCaptureGlobal {
	ashTestMessage?: {
		options?: MessageBoxOptions;
		finish?: (response: number) => void;
		restore: () => void;
	};
}

/** Exercises the product dialog boundary on both supported hosts. */
export class Dialogs {
	constructor(private readonly page: Page) { }

	async expectMessage(application: PlaywrightApplication, title: string, open: () => Promise<unknown>, timeout?: number): Promise<DialogMessage> {
		return this.respond(application, title, open, undefined, timeout);
	}

	async confirm(application: PlaywrightApplication, title: string, button: string, open: () => Promise<unknown>): Promise<DialogMessage> {
		return this.respond(application, title, open, button);
	}

	private async respond(application: PlaywrightApplication, title: string, open: () => Promise<unknown>, button?: string, timeout?: number): Promise<DialogMessage> {
		if (!('windows' in application)) {
			await open();
			const dialog = this.page.getByRole('dialog', { name: title, exact: true });
			await expect(dialog).toBeVisible({ timeout });
			const message = await dialog.evaluate(element => ({
				title: element.querySelector('.ash-dialog-title')!.textContent!,
				message: element.querySelector('.ash-dialog-message')!.textContent!,
				detail: element.querySelector('.ash-dialog-detail')?.textContent ?? '',
				buttons: [...element.querySelectorAll('.ash-dialog-actions button')].map(button => button.textContent!),
			}));
			if (button) {
				if (!message.buttons.includes(button)) {
					await this.page.keyboard.press('Escape');
					throw new Error(`Expected dialog button: ${button}`);
				}
				await dialog.getByRole('button', { name: button, exact: true }).click();
			}
			else { await this.page.keyboard.press('Escape'); }
			return message;
		}
		// Playwright cannot drive OS dialogs. Keep Main's actual request pending
		// until asserted, so the renderer completes its normal focus restoration.
		await application.evaluate(({ dialog }) => {
			const original = dialog.showMessageBox;
			const state = globalThis as DialogCaptureGlobal;
			if (state.ashTestMessage) throw new Error('Another test dialog capture is active');
			state.ashTestMessage = { restore: () => { dialog.showMessageBox = original; delete state.ashTestMessage; } };
			dialog.showMessageBox = ((...args: [MessageBoxOptions] | [BrowserWindow, MessageBoxOptions]) => new Promise(resolve => {
				state.ashTestMessage!.options = args.length === 1 ? args[0] : args[1];
				state.ashTestMessage!.finish = response => resolve({ response, checkboxChecked: false });
			})) as typeof dialog.showMessageBox;
		});
		let response: number | undefined;
		try {
			await open();
			await expect.poll(() => application.evaluate(() => (globalThis as DialogCaptureGlobal).ashTestMessage?.options?.title), { timeout }).toBe(title);
			const message = await application.evaluate(() => {
				const options = (globalThis as DialogCaptureGlobal).ashTestMessage!.options!;
				return { title: options.title!, message: options.message, detail: options.detail ?? '', buttons: options.buttons ?? [] };
			});
			if (button) {
				const selected = message.buttons.indexOf(button);
				if (selected < 0) throw new Error(`Expected dialog button: ${button}`);
				response = selected;
			}
			return message;
		} finally {
			await application.evaluate((_, response) => {
				const state = (globalThis as DialogCaptureGlobal).ashTestMessage!;
				state.finish?.(response ?? state.options?.cancelId ?? 0);
				state.restore();
			}, response);
		}
	}
}
