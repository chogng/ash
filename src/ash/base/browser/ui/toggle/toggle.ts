import { Emitter, type Event } from "../../../common/event.js";
import { Disposable, toDisposable } from "../../../common/lifecycle.js";
import { addDisposableListener, h, text as createText } from "../../dom.js";

export interface ToggleOptions {
	readonly checked?: boolean;
	readonly disabled?: boolean;
	readonly ariaLabel?: string;
	readonly content?: Node;
	readonly label?: string;
	readonly contentPlacement?: "after-control" | "before-control";
	readonly onChange?: (checked: boolean) => void;
}

/** A reusable two-state boolean control shared by checkbox and switch presentations. */
export class Toggle extends Disposable {
	readonly element: HTMLLabelElement;
	readonly input: HTMLInputElement;
	protected readonly contentElement: HTMLSpanElement | undefined;
	private readonly _onDidChange = this._register(new Emitter<boolean>());
	private enabledState: boolean;
	private busyState = false;
	readonly onDidChange: Event<boolean> = this._onDidChange.event;

	constructor(container: HTMLElement, options: ToggleOptions) {
		super();
		const ownerDocument = container.ownerDocument;
		const element = h(ownerDocument, "label");
		this.element = element;
		this._register(toDisposable(() => element.remove()));
		element.className = "ash-toggle";

		const input = h(ownerDocument, "input");
		this.input = input;
		input.type = "checkbox";
		input.checked = options.checked ?? false;
		this.enabledState = options.disabled !== true;
		input.disabled = !this.enabledState;
		if (options.ariaLabel) input.setAttribute("aria-label", options.ariaLabel);
		element.append(input);
		const content = options.content ?? (options.label ? createText(ownerDocument, options.label) : undefined);
		if (content) {
			if (options.contentPlacement === "before-control") {
				const contentElement = h(ownerDocument, "span");
				this.contentElement = contentElement;
				contentElement.className = "ash-toggle-content";
				contentElement.append(content);
				element.append(contentElement);
			} else {
				this.contentElement = undefined;
				element.append(content);
			}
		} else {
			this.contentElement = undefined;
		}
		if (options.contentPlacement === "before-control") element.classList.add("ash-toggle-content-before-control");
		container.append(element);

		this._register(addDisposableListener(input, "change", () => {
			this.syncState();
			this._onDidChange.fire(input.checked);
			options.onChange?.(input.checked);
		}));
		this.syncState();
	}

	get checked(): boolean { return this.input.checked; }

	set checked(value: boolean) {
		if (value === this.input.checked) return;
		this.input.checked = value;
		this.syncState();
	}

	get enabled(): boolean { return this.enabledState; }

	set enabled(value: boolean) {
		if (value === this.enabledState) return;
		this.enabledState = value;
		this.syncState();
	}

	get busy(): boolean { return this.busyState; }

	set busy(value: boolean) {
		if (value === this.busyState) return;
		this.busyState = value;
		this.syncState();
	}

	focus(): void { this.input.focus(); }

	blur(): void { this.input.blur(); }

	setAriaLabel(label: string): void {
		this.input.setAttribute("aria-label", label);
	}

	protected syncState(): void {
		this.input.disabled = !this.enabledState || this.busyState;
		this.element.classList.toggle("checked", this.input.checked);
		this.element.classList.toggle("disabled", !this.enabledState);
		this.element.classList.toggle("busy", this.busyState);
		if (this.busyState) this.input.setAttribute("aria-busy", "true");
		else this.input.removeAttribute("aria-busy");
		if (this.input.getAttribute("role") === "switch") {
			this.input.setAttribute("aria-checked", String(this.input.checked));
		}
	}
}

/** A native checkbox presentation backed by the shared Toggle state model. */
export class Checkbox extends Toggle {
	constructor(container: HTMLElement, options: ToggleOptions) {
		super(container, options);
		this.element.classList.add("ash-checkbox");
	}
}

/** A compact on/off switch presentation backed by the shared Toggle state model. */
export class Switch extends Toggle {
	readonly track: HTMLSpanElement;

	constructor(container: HTMLElement, options: ToggleOptions) {
		super(container, options);
		this.element.classList.add("ash-switch");
		this.input.setAttribute("role", "switch");
		const track = h(this.element.ownerDocument, "span");
		this.track = track;
		track.className = "ash-switch-track";
		track.setAttribute("aria-hidden", "true");
		const contentPlacement = options.contentPlacement;
		if (contentPlacement === "before-control" && this.contentElement) this.element.append(track);
		else this.element.insertBefore(track, this.input.nextSibling);
		this.syncState();
	}
}
