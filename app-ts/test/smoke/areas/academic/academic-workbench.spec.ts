import { expect, test } from "../../../automation/test.js";

test("Academic stays in its Workbench without a dedicated Sessions surface", async ({ application, target, workbench }) => {
	test.skip(
		target.kind !== "electron" || target.workbenchMode !== "academic",
		"This scenario verifies the Academic Electron Workbench.",
	);
	if (target.kind !== "electron") {
		return;
	}
	if (!("windows" in application)) {
		throw new Error("Academic Workbench verification requires Electron");
	}

	await expect(workbench.element).toBeVisible();
	await expect(workbench.page.locator("[data-action-id='ash.academic.open-sessions']")).toHaveCount(0);
	await expect.poll(() => application.windows().length).toBe(1);
});
