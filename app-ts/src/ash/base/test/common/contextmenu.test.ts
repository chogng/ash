import assert from "node:assert/strict";
import { test } from "mocha";
import {
	validateNativeContextMenuClose,
	validateNativeContextMenuRequest,
} from "../../parts/contextmenu/common/contextmenu.js";

test("native context menu validation accepts bounded nested menus", () => {
	assert.deepEqual(
		validateNativeContextMenuRequest({
			x: 12,
			y: 34,
			items: [
				{
					type: "action",
					id: "action-1",
					label: "Open",
					enabled: true,
				},
				{ type: "separator" },
				{
					type: "submenu",
					label: "More",
					enabled: true,
					items: [
						{
							type: "action",
							id: "action-2",
							label: "Pinned",
							enabled: true,
							checked: true,
							accelerator: "Command+P",
						},
					],
				},
			],
		}),
		{
			x: 12,
			y: 34,
			items: [
				{
					type: "action",
					id: "action-1",
					label: "Open",
					enabled: true,
				},
				{ type: "separator" },
				{
					type: "submenu",
					label: "More",
					enabled: true,
					items: [
						{
							type: "action",
							id: "action-2",
							label: "Pinned",
							enabled: true,
							checked: true,
							accelerator: "Command+P",
						},
					],
				},
			],
		},
	);
	assert.deepEqual(validateNativeContextMenuClose(undefined), {});
});

test("native context menu validation rejects unsafe payloads", () => {
	const action = {
		type: "action",
		id: "duplicate",
		label: "Action",
		enabled: true,
	};

	assert.throws(
		() => validateNativeContextMenuRequest({
			x: 0,
			y: 0,
			items: [action, action],
		}),
		/duplicate/,
	);
	assert.throws(
		() => validateNativeContextMenuRequest({
			x: 0,
			y: 0,
			items: [{ ...action, unexpected: true }],
		}),
		/exactly/,
	);
	assert.throws(
		() => validateNativeContextMenuRequest({
			x: Number.POSITIVE_INFINITY,
			y: 0,
			items: [action],
		}),
		/bounded safe integer/,
	);
});
