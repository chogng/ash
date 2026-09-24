import { GlobalStyleSheet } from "../../../base/browser/domStylesheets.js";
import { Disposable } from "../../../base/common/lifecycle.js";

/** Named boundaries for the global browser stacking context. */
export enum ZIndex {
	Base = 0,
	Sash = 35,
	SuggestWidget = 40,
	Hover = 50,
	DragImage = 1_000,
	MenubarMenuItemsHolder = 2_000,
	ContextView = 2_500,
	ModalDialog = 2_600,
	PaneDropOverlay = 10_000,
}

const ZIndexValues = [
	ZIndex.Base,
	ZIndex.Sash,
	ZIndex.SuggestWidget,
	ZIndex.Hover,
	ZIndex.DragImage,
	ZIndex.MenubarMenuItemsHolder,
	ZIndex.ContextView,
	ZIndex.ModalDialog,
	ZIndex.PaneDropOverlay,
];

/**
 * Registers named z-index values and projects them as CSS variables into every
 * registered browser window.
 */
export class ZIndexRegistry extends Disposable {
	private readonly styleSheet = this._register(new GlobalStyleSheet());
	private readonly values = new Map<string, number>();

	registerZIndex(relativeLayer: ZIndex, offset: number, name: string): string {
		validateName(name);
		if (this.values.has(name)) {
			throw new Error(`z-index with name ${name} has already been registered`);
		}
		if (!Number.isSafeInteger(offset) || offset < 0) {
			throw new RangeError("z-index offset must be a non-negative integer");
		}

		const value = relativeLayer + offset;
		if (findBase(value) !== relativeLayer) {
			throw new RangeError(
				`Relative z-index layer ${relativeLayer} is exceeded by ${value}`,
			);
		}
		this.values.set(name, value);
		this.updateStyleSheet();
		return this.variableName(name);
	}

	private variableName(name: string): string {
		return `--ash-z-index-${name}`;
	}

	private updateStyleSheet(): void {
		const declarations = [...this.values.entries()]
			.map(([name, value]) => `  ${this.variableName(name)}: ${value};`)
			.join("\n");
		this.styleSheet.setText(`:root {\n${declarations}\n}`);
	}
}

const zIndexRegistry = new ZIndexRegistry();

export const ZIndexVariables = Object.freeze({
	sash: zIndexRegistry.registerZIndex(ZIndex.Sash, 0, "sash"),
	quickInput: zIndexRegistry.registerZIndex(
		ZIndex.ModalDialog,
		0,
		"quick-input",
	),
	contextView: zIndexRegistry.registerZIndex(
		ZIndex.ContextView,
		0,
		"context-view",
	),
});

export function registerZIndex(
	relativeLayer: ZIndex,
	offset: number,
	name: string,
): string {
	return zIndexRegistry.registerZIndex(relativeLayer, offset, name);
}

function findBase(value: number): ZIndex {
	let base = ZIndex.Base;
	for (const candidate of ZIndexValues) {
		if (value >= candidate) base = candidate;
	}
	return base;
}

function validateName(name: string): void {
	if (!/^[a-z][a-z0-9-]*$/.test(name)) {
		throw new TypeError(
			"z-index name must start with a lowercase letter and contain only lowercase letters, digits, or hyphens",
		);
	}
}
