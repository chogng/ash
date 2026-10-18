import { expect, type Locator } from '@playwright/test';
import { captureDocumentStyles, compareDocumentStyles } from '../../fixtures/documentStyles.js';

/** Keep DOM identities in the owning frame instead of serializing them to Node. */
export async function trackDocumentStyles(root: Locator) {
	const before = await root.evaluateHandle(captureDocumentStyles);
	return {
		async assertUnchanged(): Promise<void> {
			const after = await root.evaluateHandle(captureDocumentStyles);
			try {
				expect(await before.evaluate(compareDocumentStyles, after), 'Document styles must match the baseline').toEqual([]);
			} finally {
				await after.dispose();
			}
		},
		async [Symbol.asyncDispose](): Promise<void> { await before.dispose(); },
	};
}
