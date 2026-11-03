import { localize } from '../../../../../../nls.js';
import type { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';

/** Names a directory definition without accepting paths or changing existing files. */
export async function askForPromptFileName(quickInput: IQuickInputService): Promise<string | undefined> {
	const valid = (value: string): boolean => /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value.trim());
	const message = localize('prompt.create.invalidName', 'Use 1 to 64 lowercase letters, numbers and hyphens, with a letter or number at each end.');
	const value = await quickInput.input({
		title: localize('prompt.create.nameTitle', 'Name the definition'),
		placeHolder: localize('prompt.create.namePlaceholder', 'Name without the .md extension'),
		validateInput: async value => valid(value) ? undefined : message,
	});
	if (value === undefined) { return undefined; }
	if (!valid(value)) { throw new Error(message); }
	return value.trim();
}
