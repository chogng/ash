import { type Event } from "../../../../base/common/event.js";
import { type IDisposable } from "../../../../base/common/lifecycle.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import { type ITaskRun } from "../../tasks/common/taskService.js";

export type TestRunStatus = "running" | "completed" | "passed" | "failed" | "canceled";

export interface ITestProfile {
	readonly id: string;
	readonly label: string;
	readonly source: string;
	readonly taskId: string;
	readonly detail?: string;
}

/** Named test-task projection returned by a dynamic provider. This is not a test tree API. */
export interface TestProfileContribution {
	readonly id: string;
	readonly label: string;
	readonly taskId: string;
	readonly detail?: string;
}

export interface TestProfileProvider {
	readonly id: string;
	provideTestProfiles(signal: AbortSignal): readonly TestProfileContribution[] | PromiseLike<readonly TestProfileContribution[]>;
}

/** One caller-owned Test Profile provider set that can be atomically replaced. */
export interface TestProfileProviderRegistration extends IDisposable {
	replace(providers: readonly TestProfileProvider[]): void;
}

export interface ITestRun {
	readonly profile: ITestProfile;
	readonly taskRun: ITaskRun;
	readonly status: TestRunStatus;
	readonly onDidChangeStatus: Event<TestRunStatus>;
}

/** Test workflow over explicit test-group workspace tasks. */
export interface ITestingService extends IDisposable {
	readonly profiles: readonly ITestProfile[];
	readonly runs: readonly ITestRun[];
	readonly onDidChangeProfiles: Event<readonly ITestProfile[]>;
	readonly onDidStartRun: Event<ITestRun>;
	readonly onDidChangeRun: Event<ITestRun>;

	registerTestProfileProvider(provider: TestProfileProvider): IDisposable;
	registerTestProfileProviders(providers: readonly TestProfileProvider[]): TestProfileProviderRegistration;
	refresh(): Promise<readonly ITestProfile[]>;
	run(profile: ITestProfile): Promise<ITestRun>;
	runAll(): Promise<readonly ITestRun[]>;
	rerun(run: ITestRun): Promise<ITestRun>;
	cancel(run: ITestRun): Promise<void>;
}

export const ITestingService = createServiceIdentifier<ITestingService>("testingService");
