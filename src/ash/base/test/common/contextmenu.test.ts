import assert from 'node:assert/strict';
import { test } from 'mocha';
import {
	validateNativeContextMenuClose,
	validateNativeContextMenuRequest,
	validateContextMenuWindowPresentation,
} from '../../parts/contextmenu/common/contextmenu.js';

test('menu window presentation validates menu names and integer native bounds', () => {
	const request = { windowName: 'ash-context-menu-11111111-1111-4111-8111-111111111111', bounds: { x: -500, y: 33, width: 200, height: 400 } };
	assert.deepEqual(validateContextMenuWindowPresentation(request), request);
	for (const windowName of ['main', 'ash-auxiliary-11111111', '', 1]) {
		assert.throws(() => validateContextMenuWindowPresentation({ ...request, windowName }));
	}
	for (const bounds of [
		{ ...request.bounds, x: NaN }, { ...request.bounds, y: Infinity },
		{ ...request.bounds, width: 0 }, { ...request.bounds, height: -1 },
		{ ...request.bounds, x: 0.5 }, { ...request.bounds, width: 1_000_001 },
		{ ...request.bounds, extra: true },
	]) {
		assert.throws(() => validateContextMenuWindowPresentation({ ...request, bounds }));
	}
	assert.throws(() => validateContextMenuWindowPresentation({ ...request, parentId: 1 }));
});

test('native context menu validation accepts bounded nested menus', () => {
	assert.deepEqual(
		validateNativeContextMenuRequest({
			x: 12.5,
			y: 34,
			elementAnchor: true,
			positioningItem: 0,
			items: [
				{
					type: 'action',
					id: 'action-1',
					label: 'Open',
					enabled: true,
				},
				{ type: 'separator' },
				{
					type: 'submenu',
					label: 'More',
					enabled: true,
					items: [
						{
							type: 'action',
							id: 'action-2',
							label: 'Pinned',
							enabled: true,
							checked: true,
							accelerator: 'Command+P',
						},
					],
				},
			],
		}),
		{
			x: 12.5,
			y: 34,
			elementAnchor: true,
			positioningItem: 0,
			items: [
				{
					type: 'action',
					id: 'action-1',
					label: 'Open',
					enabled: true,
				},
				{ type: 'separator' },
				{
					type: 'submenu',
					label: 'More',
					enabled: true,
					items: [
						{
							type: 'action',
							id: 'action-2',
							label: 'Pinned',
							enabled: true,
							checked: true,
							accelerator: 'Command+P',
						},
					],
				},
			],
		},
	);
	assert.deepEqual(validateNativeContextMenuClose(undefined), {});
});

test('native context menu validation rejects unsafe payloads', () => {
	const action = {
		type: 'action',
		id: 'duplicate',
		label: 'Action',
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
		/bounded finite number/,
	);
	assert.throws(
		() => validateNativeContextMenuRequest({
			x: 0,
			y: 0,
			positioningItem: 1,
			items: [action],
		}),
		/top-level menu item/,
	);
});
