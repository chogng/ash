import { type Event } from "../../../../base/common/event.js";
import { type IDisposable } from "../../../../base/common/lifecycle.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import { type ITaskRun } from "../../tasks/common/taskService.js";
import type { URI } from '../../../../base/common/uri.js';
import type { TestItem, TestResult } from '../../../../platform/testing/common/testExecutionService.js';

export interface ITestCase extends TestItem {
	readonly key: string;
	readonly dirId: string;
	readonly resource: URI | undefined;
}

export interface ITestCaseResult extends TestResult {
	readonly key: string;
}

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

/** Workspace test cases with backend results, plus independently executed script profiles. */
export interface ITestingService extends IDisposable {
	readonly tests: readonly ITestCase[];
	readonly testResults: readonly ITestCaseResult[];
	readonly isDiscovering: boolean;
	readonly isRunningTests: boolean;
	readonly isDebuggingTest: boolean;
	readonly onDidChangeTests: Event<void>;
	refreshTests(): Promise<void>;
	runTests(keys: readonly string[]): Promise<void>;
	debugTest(key: string): Promise<void>;
	rerunFailedTests(): Promise<void>;
	cancelTests(): Promise<void>;
	readonly profiles: readonly ITestProfile[];
	readonly runs: readonly ITestRun[];
	readonly onDidChangeProfiles: Event<readonly ITestProfile[]>;
	readonly onDidStartRun: Event<ITestRun>;
	readonly onDidChangeRun: Event<ITestRun>;

	registerTestProfileProvider(provider: TestProfileProvider): IDisposable;
	registerTestProfileProviders(providers: readonly TestProfileProvider[]): TestProfileProviderRegistration;
	refresh(): Promise<readonly ITestProfile[]>;
	run(profile: ITestProfile): Promise<ITestRun>;
	runAllScripts(): Promise<readonly ITestRun[]>;
	rerun(run: ITestRun): Promise<ITestRun>;
	cancel(run: ITestRun): Promise<void>;
}

export const ITestingService = createServiceIdentifier<ITestingService>("testingService");
