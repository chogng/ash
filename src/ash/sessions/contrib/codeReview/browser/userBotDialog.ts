import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { createWorkbenchDialogOptions } from '../../../../workbench/browser/parts/dialogs/dialog.js';

export const createUserBotLabel = localize('sessions.bots.createUserBot', 'Create Bot');
export const editUserBotLabel = localize('sessions.bots.editUserBot', 'Edit Bot');

interface UserBotText {
	readonly name: string;
	readonly description: string;
	readonly prompt: string;
}

export async function showUserBotDialog(container: HTMLElement, token: CancellationToken,
	save: (definition: UserBotText) => Promise<void>, existing?: UserBotText,
): Promise<string | undefined> {
	if (token.isCancellationRequested) return undefined;
	using store = new DisposableStore();
	const document = container.ownerDocument;
	const form = h(document, 'form', { className: 'ash-user-bot-form', properties: { id: generateUuid() } });
	const actions = h(document, 'div', { className: 'ash-sessions-form-actions' });
	const error = h(document, 'p', { attributes: { role: 'alert' } });
	const field = <Multiline extends boolean>(label: string, multiline: Multiline) => {
		const row = h(document, 'div', { className: 'ash-user-bot-field' });
		const title = h(document, 'label', {}, label);
		row.append(title);
		const input = store.add(new InputBox(row, {
			ariaLabel: label, inputBoxStyles: defaultInputBoxStyles, presentation: 'field', flexibleHeight: multiline,
		}));
		input.inputElement.id = title.htmlFor = generateUuid();
		input.inputElement.required = true;
		form.append(row);
		return input;
	};
	const name = field(localize('sessions.bots.userBotName', 'Bot name'), false);
	name.inputElement.maxLength = 64;
	name.value = existing?.name ?? '';
	name.readOnly = !!existing;
	if (!existing) {
		const nameHelp = h(document, 'p', { properties: { id: generateUuid() } }, localize('sessions.bots.userBotNameHelp', 'Use lowercase letters, numbers, and hyphens. This name is used in @ mentions.'));
		name.element.after(nameHelp);
		name.inputElement.setAttribute('aria-describedby', nameHelp.id);
	}
	const description = field(localize('sessions.bots.userBotDescription', 'Description'), false);
	const prompt = field(localize('sessions.bots.userBotInstructions', 'Instructions'), true);
	description.value = existing?.description ?? '';
	prompt.value = existing?.prompt ?? '';
	form.append(error);
	let saving = false;
	let savedName: string | undefined;
	const dialog = store.add(new Dialog(container, existing ? editUserBotLabel : createUserBotLabel, [], createWorkbenchDialogOptions({
		layout: 'form', disableDefaultAction: true, canClose: () => !saving,
		shouldConfirmDiscard: () => savedName === undefined && (name.value !== (existing?.name ?? '')
			|| description.value !== (existing?.description ?? '') || prompt.value !== (existing?.prompt ?? '')),
		renderBody: body => body.append(form), renderFooter: footer => footer.append(actions),
	})));
	const cancel = store.add(new Button(actions, {
		...defaultButtonStyles, presentation: 'secondary', label: localize('sessions.bots.cancelUserBot', 'Cancel'),
		onClick: () => void dialog.requestClose(),
	}));
	const submit = store.add(new Button(actions, {
		...defaultButtonStyles, presentation: 'primary', type: 'submit',
		label: existing ? localize('sessions.bots.saveUserBot', 'Save') : createUserBotLabel,
	}));
	submit.domNode.setAttribute('form', form.id);
	store.add(token.onCancellationRequested(() => dialog.dispose()));
	store.add(addDisposableListener(form, 'submit', async event => {
		event.preventDefault();
		if (saving) return;
		const handle = existing?.name ?? name.value.trim();
		if (!existing && (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(handle) || /^(ash|advisor|codereview|issue)$/u.test(handle))) {
			error.textContent = localize('sessions.bots.userBotInvalidName', 'Choose an available name that starts and ends with a lowercase letter or number.');
			name.focus();
			return;
		}
		if (!description.value.trim() || !prompt.value.trim()) {
			error.textContent = localize('sessions.bots.userBotRequired', 'Enter a description and instructions for this Bot.');
			(description.value.trim() ? prompt : description).focus();
			return;
		}
		saving = true;
		error.textContent = '';
		form.setAttribute('aria-busy', 'true');
		for (const input of [name, description, prompt]) input.readOnly = true;
		submit.enabled = cancel.enabled = false;
		try {
			await save({ name: handle, description: description.value.trim(), prompt: prompt.value.trim() });
			savedName = handle;
			dialog.dispose();
		} catch (failure) {
			if (token.isCancellationRequested) return;
			saving = false;
			form.removeAttribute('aria-busy');
			for (const input of [name, description, prompt]) input.readOnly = false;
			name.readOnly = !!existing;
			submit.enabled = cancel.enabled = true;
			error.textContent = toErrorMessage(failure);
			submit.focus();
		}
	}));
	const result = dialog.show();
	(existing ? description : name).focus();
	await result;
	return token.isCancellationRequested ? undefined : savedName;
}
