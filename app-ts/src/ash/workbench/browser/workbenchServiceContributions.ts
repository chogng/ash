import { type IDisposable } from "../../base/common/lifecycle.js";
import { type ServiceContainer, type ServiceIdentifier } from "../../platform/instantiation/common/instantiation.js";

export interface WorkbenchServiceContributionContext {
	readonly container: ServiceContainer;
	readonly register: <T extends IDisposable>(value: T) => T;
	readonly blockRestorationUntil: (operation: Promise<void>) => void;
}

export interface WorkbenchServiceContribution<T> {
	readonly service: ServiceIdentifier<T>;
	readonly dependencies: readonly ServiceIdentifier<unknown>[];
	readonly install: (context: WorkbenchServiceContributionContext) => T;
}

export class WorkbenchServiceContributionRegistry {
	private readonly contributions: WorkbenchServiceContribution<unknown>[] = [];

	register<T>(contribution: WorkbenchServiceContribution<T>): void {
		if (this.contributions.some(candidate => candidate.service === contribution.service)) throw new Error(`Workbench service '${serviceName(contribution.service)}' was contributed more than once`);
		this.contributions.push(contribution as WorkbenchServiceContribution<unknown>);
	}

	install(context: WorkbenchServiceContributionContext): void {
		const pending = [...this.contributions];
		while (pending.length > 0) {
			const readyIndex = pending.findIndex(contribution => contribution.dependencies.every(dependency => context.container.has(dependency)));
			if (readyIndex < 0) {
				const unresolved = pending.map(contribution => `${serviceName(contribution.service)} <- ${contribution.dependencies.filter(dependency => !context.container.has(dependency)).map(serviceName).join(", ")}`).join("; ");
				throw new Error(`Workbench service contributions have missing or cyclic dependencies: ${unresolved}`);
			}
			const [contribution] = pending.splice(readyIndex, 1);
			const service = contribution!.install(context);
			context.container.registerInstance(contribution!.service, service);
		}
	}
}

export const WorkbenchServiceContributionsRegistry = new WorkbenchServiceContributionRegistry();

/** Registers services owned by a statically selected Workbench mode bundle. */
export function registerWorkbenchServiceContribution<T>(contribution: WorkbenchServiceContribution<T>): void {
	WorkbenchServiceContributionsRegistry.register(contribution);
}

export function installWorkbenchServiceContributions(context: WorkbenchServiceContributionContext): void {
	WorkbenchServiceContributionsRegistry.install(context);
}

function serviceName(service: ServiceIdentifier<unknown>): string {
	return service.description ?? String(service);
}
