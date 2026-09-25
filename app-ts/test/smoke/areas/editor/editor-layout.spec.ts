import type { Locator } from "@playwright/test";
import { expect, test } from "../../../automation/test.js";

test("empty editor distinguishes an empty window from an open workspace", async ({ target, workbench }) => {
	const editors = workbench.editors;
	const group = editors.groupAt(0);
	const welcomeVisible = target.kind === 'browser' && target.appServerMode === 'disabled';

	await expect(editors.element).toBeVisible();
	await expect(group.element).toBeVisible();
	await expect(group.title).toBeVisible();
	await expect(group.content).toBeVisible();
	await expect(group.watermark).toBeVisible({ visible: welcomeVisible });
	await expect(group.tabs).toHaveCount(0);

	await expect.poll(async () => editorGeometry(editors.element, group.element, group.title, group.content, group.watermark)).toEqual({
		groupFillsEditorClient: true,
		titleAboveContent: true,
		titleHasHeight: true,
		contentHasArea: true,
		watermarkInsideContent: welcomeVisible ? true : null,
	});
});

test.describe('welcome brand', () => {
	test.use({ openWorkspace: false });

	test('welcome displays only the Ash name above the actions', async ({ workbench }) => {
		const welcome = workbench.editors.groupAt(0).watermark;
		await expect(welcome.locator('.ash-editor-group-welcome-name')).toHaveText('ASH');
		await expect(welcome.locator('.ash-editor-group-welcome-plan')).toHaveCount(0);
		await expect(welcome.getByRole('button', { name: 'Open folder' })).toBeVisible();
	});

	test('welcome uses the theme-colored mark without a filled icon tile', async ({ workbench }) => {
		const mark = workbench.editors.groupAt(0).watermark.locator('.ash-editor-group-welcome-mark');
		await expect(mark).toBeVisible();
		await expect(mark).toHaveAttribute('aria-hidden', 'true');
		await expect(mark).toHaveCSS('mask-image', /ash-mark.*\.svg/u);
		await expect(mark).toHaveCSS('background-image', 'none');
		await expect(mark).toHaveCSS('background-color', await mark.evaluate(element => getComputedStyle(element).color));
	});
});

test("editor layout remains valid across workbench window sizes", async ({ target, driver, workbench }) => {
	const editors = workbench.editors;
	const group = editors.groupAt(0);
	const observedSizes = new Set<string>();
	const welcomeVisible = target.kind === 'browser' && target.appServerMode === 'disabled';

	for (const size of [{ width: 900, height: 700 }, { width: 1200, height: 800 }, { width: 1494, height: 1104 }]) {
		const actualSize = await driver.setWindowSize(size);
		observedSizes.add(`${actualSize.width}x${actualSize.height}`);
		await expect.poll(async () => editorGeometry(editors.element, group.element, group.title, group.content, group.watermark), { message: `editor geometry at ${size.width}x${size.height}` }).toEqual({
			groupFillsEditorClient: true,
			titleAboveContent: true,
			titleHasHeight: true,
			contentHasArea: true,
			watermarkInsideContent: welcomeVisible ? true : null,
		});
	}

	expect(observedSizes.size).toBe(3);
});

test("split editor groups keep visible boundaries", async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== "code", "This scenario requires the Code product");
	const editors = workbench.editors;
	const page = workbench.page;

	for (const command of ["Split Editor Horizontal", "Split Editor Vertical"]) {
		await page.keyboard.press("F1");
		const picker = page.locator(".ash-quick-pick");
		await picker.getByRole("combobox").fill(command);
		await expect(picker.locator(".ash-quick-pick-row-label").filter({ hasText: command })).toBeVisible();
		await page.keyboard.press("Enter");
	}

	await expect(editors.groups).toHaveCount(3);
	const borderedPanes = editors.element.locator(".ash-split-view-separator-border > .ash-split-view-pane:not(:first-child)");
	await expect(borderedPanes).toHaveCount(2);
	const borderColor = await editors.element.evaluate(element => {
		const probe = element.ownerDocument.createElement("span");
		probe.style.color = "var(--ash-editor-group-border)";
		element.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	});
	await expect.poll(() => borderedPanes.evaluateAll(elements => elements.map(element => {
		const style = getComputedStyle(element, "::before");
		return { color: style.backgroundColor, thickness: element.parentElement?.classList.contains("ash-split-view-horizontal") ? style.width : style.height };
	}))).toEqual([
		{ color: borderColor, thickness: "1px" },
		{ color: borderColor, thickness: "1px" },
	]);
});

async function editorGeometry(editor: Locator, group: Locator, title: Locator, content: Locator, watermark: Locator) {
	const [editorBox, editorClient, groupBox, titleBox, contentBox, watermarkBox] = await Promise.all([
		editor.boundingBox(),
		editor.evaluate(element => {
			const editorElement = element as HTMLElement;
			return {
				x: editorElement.clientLeft,
				y: editorElement.clientTop,
				width: editorElement.clientWidth,
				height: editorElement.clientHeight,
			};
		}),
		group.boundingBox(),
		title.boundingBox(),
		content.boundingBox(),
		watermark.boundingBox(),
	]);
	if (!editorBox || !groupBox || !titleBox || !contentBox) {
		return null;
	}
	const tolerance = 1;
	return {
		groupFillsEditorClient: approximatelyEqual(groupBox.x, editorBox.x + editorClient.x, tolerance)
			&& approximatelyEqual(groupBox.y, editorBox.y + editorClient.y, tolerance)
			&& approximatelyEqual(groupBox.width, editorClient.width, tolerance)
			&& approximatelyEqual(groupBox.height, editorClient.height, tolerance),
		titleAboveContent: titleBox.y + titleBox.height <= contentBox.y + tolerance,
		titleHasHeight: titleBox.height > 0,
		contentHasArea: contentBox.width > 0 && contentBox.height > 0,
		watermarkInsideContent: watermarkBox ? contains(contentBox, watermarkBox, tolerance) : null,
	};
}

function approximatelyEqual(first: number, second: number, tolerance: number): boolean {
	return Math.abs(first - second) <= tolerance;
}

function contains(container: { x: number; y: number; width: number; height: number }, child: { x: number; y: number; width: number; height: number }, tolerance: number): boolean {
	return child.x >= container.x - tolerance
		&& child.y >= container.y - tolerance
		&& child.x + child.width <= container.x + container.width + tolerance
		&& child.y + child.height <= container.y + container.height + tolerance;
}
