export const NATIVE_MENUBAR_UPDATE_CHANNEL = "ash:menubar:update";
export const NATIVE_MENUBAR_SELECT_CHANNEL = "ash:menubar:select";

export interface INativeMenubarSeparator {
	readonly type: "separator";
}

export interface INativeMenubarAction {
	readonly type: "action";
	readonly id: string;
	readonly altId?: string;
	readonly label: string;
	readonly enabled: boolean;
	readonly checked?: boolean;
}

export interface INativeMenubarSubmenu {
	readonly type: "submenu";
	readonly label: string;
	readonly enabled: boolean;
	readonly items: readonly NativeMenubarItem[];
}

export type NativeMenubarItem =
	| INativeMenubarSeparator
	| INativeMenubarAction
	| INativeMenubarSubmenu;

export interface INativeMenubarMenu {
	readonly label: string;
	readonly items: readonly NativeMenubarItem[];
}

export interface INativeMenubarData {
	readonly revision: number;
	readonly menus: readonly INativeMenubarMenu[];
}

export interface INativeMenubarSelection {
	readonly revision: number;
	readonly id: string;
}

export interface INativeMenubarSubscription {
	dispose(): void;
}

/** Narrow Electron capability used to synchronize the macOS application menu. */
export interface INativeMenubarApi {
	update(data: INativeMenubarData): Promise<void>;
	onDidSelect(
		listener: (selection: INativeMenubarSelection) => void,
	): INativeMenubarSubscription;
}

const MAX_MENU_DEPTH = 8;
const MAX_MENU_ITEMS = 256;
const MAX_ITEMS_PER_LEVEL = 64;
const MAX_TOP_LEVEL_MENUS = 16;
const MAX_ID_LENGTH = 128;
const MAX_LABEL_LENGTH = 512;

/** Validates a complete renderer-to-main application menu snapshot. */
export function validateNativeMenubarData(
	value: unknown,
): INativeMenubarData {
	const data = exactRecord(value, ["menus", "revision"]);
	if (!Array.isArray(data.menus)) {
		throw new Error("menubar menus must be an array");
	}
	if (data.menus.length > MAX_TOP_LEVEL_MENUS) {
		throw new Error("menubar contains too many top-level menus");
	}

	const state: IValidationState = {
		itemCount: 0,
		ids: new Set(),
	};
	return {
		revision: safeRevision(data.revision),
		menus: data.menus.map((candidate, index) => {
			const menu = exactRecord(candidate, ["items", "label"]);
			return {
				label: boundedString(
					menu.label,
					`menus[${index}].label`,
					MAX_LABEL_LENGTH,
				),
				items: validateItems(menu.items, 0, state),
			};
		}),
	};
}

interface IValidationState {
	itemCount: number;
	readonly ids: Set<string>;
}

function validateItems(
	value: unknown,
	depth: number,
	state: IValidationState,
): readonly NativeMenubarItem[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error("menubar items must be a non-empty array");
	}
	if (depth > MAX_MENU_DEPTH) {
		throw new Error("menubar nesting is too deep");
	}
	if (value.length > MAX_ITEMS_PER_LEVEL) {
		throw new Error("menubar level contains too many items");
	}

	return value.map((candidate, index) => {
		state.itemCount += 1;
		if (state.itemCount > MAX_MENU_ITEMS) {
			throw new Error("menubar contains too many items");
		}

		const item = looseRecord(candidate);
		switch (item.type) {
			case "separator":
				requireExactKeys(item, ["type"]);
				return { type: "separator" };
			case "action": {
				const keys = ["enabled", "id", "label", "type"];
				if (item.altId !== undefined) keys.push("altId");
				if (item.checked !== undefined) keys.push("checked");
				requireExactKeys(
					item,
					keys,
				);
				const id = uniqueActionId(item.id, `items[${index}].id`, state);
				const altId = item.altId === undefined
					? undefined
					: uniqueActionId(item.altId, `items[${index}].altId`, state);
				const action: INativeMenubarAction = {
					type: "action",
					id,
					...(altId ? { altId } : {}),
					label: boundedString(
						item.label,
						`items[${index}].label`,
						MAX_LABEL_LENGTH,
					),
					enabled: boolean(item.enabled, `items[${index}].enabled`),
				};
				return item.checked === undefined
					? action
					: {
						...action,
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

function uniqueActionId(
	value: unknown,
	field: string,
	state: IValidationState,
): string {
	const id = boundedString(value, field, MAX_ID_LENGTH);
	if (state.ids.has(id)) {
		throw new Error(`duplicate menubar action id: ${id}`);
	}
	state.ids.add(id);
	return id;
}

function exactRecord(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	const record = looseRecord(value);
	requireExactKeys(record, keys);
	return record;
}

function looseRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("menubar payload must contain objects");
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
			`menubar object must contain exactly: ${expected.join(", ")}`,
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

function safeRevision(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error("revision must be a non-negative safe integer");
	}
	return value as number;
}
