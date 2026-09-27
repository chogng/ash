import { Dialog, type DialogButton } from "../../../../base/browser/ui/dialog/dialog.js";
import { InputBox } from "../../../../base/browser/ui/inputbox/inputbox.js";
import { Checkbox } from "../../../../base/browser/ui/toggle/toggle.js";
import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { observeResize } from "../../../../base/browser/observer.js";
import { DisposableStore } from "../../../../base/common/lifecycle.js";
import { localize } from "../../../../nls.js";
import {
	type DialogRequest,
	DialogResult,
	DialogSeverity,
	type IDialogHandler,
	type IDialogOutcome,
} from "../../../../platform/dialogs/common/dialogs.js";

/** Presents workbench dialogs with browser-native modal semantics. */
export class BrowserDialogHandler implements IDialogHandler {
	private readonly container: HTMLElement;

	constructor(container: HTMLElement) {
		this.container = container;
	}

	async showDialog(
		request: DialogRequest,
		signal: AbortSignal,
	): Promise<IDialogOutcome> {
		if (signal.aborted) return { button: DialogResult.Cancel };

		const disposables = new DisposableStore();
		const ownerDocument = this.container.ownerDocument;
		try {
			const content = createDialogContent(ownerDocument, request, disposables);
			const buttons: DialogButton[] = [{
				label: request.primaryButton ??
					(request.kind === "confirmation" ? localize('dialog.confirm', 'Confirm') : localize('dialog.ok', 'OK')),
				value: DialogResult.Primary,
				presentation: "primary",
			}];
			if (request.kind === "prompt") {
				buttons.push({ label: request.secondaryButton, value: DialogResult.Secondary });
			}
			if (request.kind !== "message") {
				buttons.push({ label: request.cancelButton ?? localize('dialog.cancel', 'Cancel'), value: DialogResult.Cancel });
			}
			const dialog = disposables.add(new Dialog(this.container, {
				title: request.title ?? defaultTitle(request),
				content: content.element,
				buttons,
				cancelValue: DialogResult.Cancel,
			}));
			dialog.element.dataset.dialogSeverity =
				request.kind === "message" ? request.severity : "question";
			for (const input of content.inputs) {
				disposables.add(input.onKeyDown(event => {
					if (event.key === "Enter" && !event.isComposing) {
						event.preventDefault();
						dialog.close(DialogResult.Primary);
					}
				}));
			}

			disposables.add(addDisposableListener(signal, "abort", () => {
				dialog.close(DialogResult.Cancel);
			}, { once: true }));

			const resultPromise = dialog.show();
			if (content.detail) {
				const detail = content.detail;
				const updateFocusability = (): void => {
					if (detail.scrollHeight > detail.clientHeight) {
						detail.tabIndex = 0;
					} else {
						detail.removeAttribute("tabindex");
					}
				};
				updateFocusability();
				disposables.add(observeResize(detail, updateFocusability));
			}
			const result = await resultPromise;
			const button = result === DialogResult.Primary || result === DialogResult.Secondary
				? result : DialogResult.Cancel;
			return {
				button,
				checkboxChecked: content.checkbox?.checked,
				values: button === DialogResult.Primary && request.kind === "input"
					? content.inputs.map(input => input.value) : undefined,
			};
		} finally {
			disposables.dispose();
		}
	}
}

interface IDialogContent {
	readonly element: HTMLDivElement;
	readonly detail?: HTMLParagraphElement;
	readonly checkbox?: Checkbox;
	readonly inputs: readonly InputBox[];
}

function createDialogContent(
	ownerDocument: Document,
	request: DialogRequest,
	disposables: DisposableStore,
): IDialogContent {
	const element = h(ownerDocument, "div");
	element.className = "ash-dialog-content";

	const message = h(ownerDocument, "p");
	message.className = "ash-dialog-message";
	message.textContent = request.message;
	element.append(message);

	let detail: HTMLParagraphElement | undefined;
	if (request.detail) {
		detail = h(ownerDocument, "p");
		detail.className = "ash-dialog-detail";
		detail.textContent = request.detail;
		element.append(detail);
	}
	const inputs: InputBox[] = [];
	if (request.kind === "input") {
		const inputContainer = h(ownerDocument, "div");
		inputContainer.className = "ash-dialog-inputs";
		for (const [index, options] of request.inputs.entries()) {
			const input = disposables.add(new InputBox(inputContainer, {
				type: options.type,
				placeholder: options.placeholder,
				presentation: "field",
				ariaLabel: options.placeholder ?? localize('dialog.inputNumber', '{0}, field {1}', request.message, index + 1),
			}));
			input.value = options.value ?? "";
			inputs.push(input);
		}
		element.append(inputContainer);
	}
	let checkbox: Checkbox | undefined;
	if (request.checkbox) {
		checkbox = disposables.add(new Checkbox(element, {
			label: request.checkbox.label,
			checked: request.checkbox.checked,
		}));
	}

	return { element, detail, checkbox, inputs };
}

function defaultTitle(request: DialogRequest): string {
	if (request.kind === "input") return localize('dialog.input', 'Input');
	if (request.kind !== "message") return localize('dialog.confirm', 'Confirm');
	switch (request.severity) {
		case DialogSeverity.Warning:
			return localize('dialog.warning', 'Warning');
		case DialogSeverity.Error:
			return localize('dialog.error', 'Error');
		default:
			return localize('dialog.information', 'Information');
	}
}
