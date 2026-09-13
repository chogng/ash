import assert from "node:assert/strict";
import { test } from "mocha";
import { createServiceIdentifier, ServiceContainer } from "../../../platform/instantiation/common/instantiation.js";
import { WorkbenchServiceContributionRegistry, type WorkbenchServiceContributionContext } from "../../browser/workbenchServiceContributions.js";

test("Workbench service contributions install by declared dependency topology", () => {
	const first = createServiceIdentifier<{ readonly value: string }>("testFirst");
	const second = createServiceIdentifier<{ readonly value: string }>("testSecond");
	const registry = new WorkbenchServiceContributionRegistry();
	const installed: string[] = [];
	registry.register({ service: second, dependencies: [first], install: context => { installed.push("second"); return { value: `${context.container.get(first).value}:second` }; } });
	registry.register({ service: first, dependencies: [], install: () => { installed.push("first"); return { value: "first" }; } });
	const services = new ServiceContainer();
	registry.install(context(services));
	assert.deepEqual(installed, ["first", "second"]);
	assert.equal(services.get(second).value, "first:second");
});

test("Workbench service contributions reject duplicate and unresolved ownership", () => {
	const first = createServiceIdentifier<object>("testDuplicate");
	const missing = createServiceIdentifier<object>("testMissing");
	const registry = new WorkbenchServiceContributionRegistry();
	registry.register({ service: first, dependencies: [missing], install: () => ({}) });
	assert.throws(() => registry.register({ service: first, dependencies: [], install: () => ({}) }), /more than once/u);
	assert.throws(() => registry.install(context(new ServiceContainer())), /missing or cyclic dependencies.*testDuplicate.*testMissing/u);
});

function context(container: ServiceContainer): WorkbenchServiceContributionContext {
	return { container, register: value => value, blockRestorationUntil: () => undefined };
}
