export const NATIVE_CONTEXT_MENU_POPUP_CHANNEL =
	"ash:context-menu:popup";
export const NATIVE_CONTEXT_MENU_CLOSE_CHANNEL =
	"ash:context-menu:close";

export interface INativeContextMenuSeparator {
	readonly type: "separator";
}

export interface INativeContextMenuAction {
	readonly type: "action";
	readonly id: string;
	readonly label: string;
	readonly enabled: boolean;
	readonly checked?: boolean;
	readonly accelerator?: string;
}

export interface INativeContextSubmenu {
	readonly type: "submenu";
	readonly label: string;
	readonly enabled: boolean;
	readonly items: readonly NativeContextMenuItem[];
}

export type NativeContextMenuItem =
	| INativeContextMenuSeparator
	| INativeContextMenuAction
	| INativeContextSubmenu;

export interface INativeContextMenuRequest {
	readonly items: readonly NativeContextMenuItem[];
	readonly x: number;
	readonly y: number;
}

export interface INativeContextMenuResult {
	readonly selectedId?: string;
}

/** Narrow host capability used to present a serialized native context menu. */
export interface INativeContextMenuApi {
	popup(
		request: INativeContextMenuRequest,
	): Promise<INativeContextMenuResult>;
	close(): Promise<void>;
}

const MAX_MENU_DEPTH = 8;
const MAX_MENU_ITEMS = 256;
const MAX_ITEMS_PER_LEVEL = 64;
const MAX_ID_LENGTH = 128;
const MAX_LABEL_LENGTH = 512;
const MAX_COORDINATE = 1_000_000;

/** Validates the complete renderer-to-main native menu payload. */
export function validateNativeContextMenuRequest(
	value: unknown,
): INativeContextMenuRequest {
	const request = exactRecord(value, ["items", "x", "y"]);
	const state = {
		itemCount: 0,
		ids: new Set<string>(),
	};
	return {
		items: validateItems(request.items, 0, state),
		x: coordinate(request.x, "x"),
		y: coordinate(request.y, "y"),
	};
}

export function validateNativeContextMenuClose(
	value: unknown,
): Record<string, never> {
	if (value === undefined) return {};
	exactRecord(value, []);
	return {};
}

interface IValidationState {
	itemCount: number;
	readonly ids: Set<string>;
}

function validateItems(
	value: unknown,
	depth: number,
	state: IValidationState,
): readonly NativeContextMenuItem[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error("context menu items must be a non-empty array");
	}
	if (depth > MAX_MENU_DEPTH) {
		throw new Error("context menu nesting is too deep");
	}
	if (value.length > MAX_ITEMS_PER_LEVEL) {
		throw new Error("context menu level contains too many items");
	}

	return value.map((candidate, index) => {
		state.itemCount += 1;
		if (state.itemCount > MAX_MENU_ITEMS) {
			throw new Error("context menu contains too many items");
		}
		const item = looseRecord(candidate);
		switch (item.type) {
			case "separator":
				requireExactKeys(item, ["type"]);
				return { type: "separator" };
			case "action": {
				const keys = ["enabled", "id", "label", "type"];
				if (item.checked !== undefined) keys.push("checked");
				if (item.accelerator !== undefined) keys.push("accelerator");
				requireExactKeys(item, keys);
				const id = boundedString(
					item.id,
					`items[${index}].id`,
					MAX_ID_LENGTH,
				);
				if (state.ids.has(id)) {
					throw new Error(`duplicate context menu action id: ${id}`);
				}
				state.ids.add(id);
				const result: INativeContextMenuAction = {
					type: "action",
					id,
					label: boundedString(
						item.label,
						`items[${index}].label`,
						MAX_LABEL_LENGTH,
					),
					enabled: boolean(item.enabled, `items[${index}].enabled`),
					...(item.accelerator === undefined
						? {}
						: {
							accelerator: boundedString(
								item.accelerator,
								`items[${index}].accelerator`,
								MAX_ID_LENGTH,
							),
						}),
				};
				return item.checked === undefined
					? result
					: {
						...result,
						checked: boolean(item.checked, `items[${index}].checked`),
					};
			}
			case "submenu":
				requireExactKeys(item, [
					"enabled",
					"items",
					"label",
					"type",
				]);
				return {
					type: "submenu",
					label: boundedString(
						item.label,
						`items[${index}].label`,
						MAX_LABEL_LENGTH,
					),
					enabled: boolean(item.enabled, `items[${index}].enabled`),
					items: validateItems(item.items, depth + 1, state),
				};
			default:
				throw new Error(`items[${index}].type is invalid`);
		}
	});
}

function exactRecord(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	const result = looseRecord(value);
	requireExactKeys(result, keys);
	return result;
}

function looseRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("context menu payload must contain objects");
	}
	return value as Record<string, unknown>;
}

function requireExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		throw new Error(
			`context menu object must contain exactly: ${expected.join(", ")}`,
		);
	}
}

function boundedString(
	value: unknown,
	field: string,
	maxLength: number,
): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > maxLength
	) {
		throw new Error(`${field} must be a non-empty bounded string`);
	}
	return value;
}

function boolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${field} must be a boolean`);
	}
	return value;
}

function coordinate(value: unknown, field: string): number {
	if (
		!Number.isSafeInteger(value) ||
		Math.abs(value as number) > MAX_COORDINATE
	) {
		throw new Error(`${field} must be a bounded safe integer`);
	}
	return value as number;
}
