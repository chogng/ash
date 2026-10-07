import assert from "node:assert/strict";
import { test } from "mocha";
import {
	validateNativeMenubarData,
} from "../../../../platform/menubar/common/nativeMenubar.js";

test("native menubar validation accepts a versioned nested snapshot", () => {
	const data = {
		revision: 3,
		menus: [{
			label: "File",
			items: [
				{
					type: "action",
					id: "action-1",
					altId: "action-1-alt",
					label: "New conversation",
					enabled: true,
				},
				{ type: "separator" },
				{
					type: "submenu",
					label: "Recent",
					enabled: true,
					items: [{
						type: "action",
						id: "action-2",
						label: "Pinned",
						enabled: false,
						checked: true,
					}],
				},
			],
		}],
	};

	assert.deepEqual(validateNativeMenubarData(data), data);
	assert.deepEqual(validateNativeMenubarData({
		revision: 4,
		menus: [],
	}), {
		revision: 4,
		menus: [],
	});
});

test("native menubar validation rejects unsafe snapshots", () => {
	const action = {
		type: "action",
		id: "duplicate",
		label: "Action",
		enabled: true,
	};

	assert.throws(
		() => validateNativeMenubarData({
			revision: 1,
			menus: [{
				label: "File",
				items: [action, action],
			}],
		}),
		/duplicate/,
	);
	assert.throws(
		() => validateNativeMenubarData({
			revision: -1,
			menus: [],
		}),
		/non-negative safe integer/,
	);
	assert.throws(
		() => validateNativeMenubarData({
			revision: 1,
			menus: [{
				label: "File",
				items: [{ ...action, unexpected: true }],
			}],
		}),
		/exactly/,
	);
	assert.throws(
		() => validateNativeMenubarData({
			revision: 1,
			menus: [{
				label: "File",
				items: [{ ...action, altId: action.id }],
			}],
		}),
		/duplicate/,
	);
});
