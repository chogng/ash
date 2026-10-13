import { getKeybindingLabel, getKeybindingLabelParts, KeybindingLabelStyle } from "../../../common/keybindingLabels.js";
import type { ResolvedKeybinding } from "../../../common/keybindings.js";
import { Disposable, toDisposable } from "../../../common/lifecycle.js";
import { setAriaAttribute } from "../aria/aria.js";
import { h } from "../../dom.js";

export interface KeybindingLabelOptions {
	readonly keybinding: ResolvedKeybinding;
	readonly presentation?: KeybindingLabelPresentation;
}

/** Component-owned visual treatment for a rendered keybinding. */
export type KeybindingLabelPresentation = "plain" | "keycap";

/** Presents a resolved keybinding without owning matching or dispatch policy. */
export class KeybindingLabel extends Disposable {
	readonly element: HTMLSpanElement;
	private _keybinding: ResolvedKeybinding;

	constructor(container: HTMLElement, private readonly options: KeybindingLabelOptions) {
		super();
		const ownerDocument = container.ownerDocument;
		this._keybinding = options.keybinding;
		this.element = h(ownerDocument, "span");
		this._register(toDisposable(() => this.element.remove()));
		this.element.className = `ash-keybinding-label ash-keybinding-label-${options.presentation ?? "plain"}`;
		container.append(this.element);
		this.render();
	}

	set keybinding(keybinding: ResolvedKeybinding) {
		this._keybinding = keybinding;
		this.render();
	}

	get keybinding(): ResolvedKeybinding {
		return this._keybinding;
	}

	private render(): void {
		const ownerDocument = this.element.ownerDocument;
		const parts = getKeybindingLabelParts(this._keybinding);
		this.element.replaceChildren(...parts.map((part) => {
			if (this.options.presentation === "keycap") {
				const chord = h(ownerDocument, "span");
				chord.className = "ash-keybinding-label-chord";
				// The complete shortcut is announced by the containing label.
				chord.setAttribute("aria-hidden", "true");
				chord.append(...part.keys.map(key => {
					const token = h(ownerDocument, "kbd");
					token.textContent = key;
					return token;
				}));
				return chord;
			}
			const token = h(ownerDocument, "kbd");
			token.textContent = part.label;
			setAriaAttribute(token, "label", part.ariaLabel);
			return token;
		}));
		setAriaAttribute(
			this.element,
			"label",
			getKeybindingLabel(
				this._keybinding,
				KeybindingLabelStyle.Aria,
			),
		);
	}
}
