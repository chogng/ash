import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export type TestOperationStatus = 'running' | 'completed' | 'cancelled' | 'failed';
export type TestItemState = 'running' | 'passed' | 'failed' | 'skipped' | 'errored' | 'cancelled';

export interface TestItem {
	readonly id: string;
	readonly package: string;
	readonly target: string;
	readonly targetKind: 'library' | 'binary' | 'integration' | 'documentation';
	readonly name: string;
	readonly source: { readonly path: string; readonly line: number; } | null;
	readonly debuggable: boolean;
}

export interface TestDebugLaunch {
	readonly testId: string;
	readonly program: string;
	readonly arguments: readonly string[];
	readonly directory: string;
	readonly adapterProgram: string;
}

export interface TestResult {
	readonly testId: string;
	readonly state: TestItemState;
	readonly durationMs: number;
	readonly output: string;
	readonly outputTruncated: boolean;
	readonly failurePath: string | null;
	readonly failureLine: number | null;
}

export interface TestUpdate {
	readonly operationId: string;
	readonly sequence: number;
	readonly status: TestOperationStatus;
	readonly tests: readonly TestItem[] | null;
	readonly result: TestResult | null;
	readonly error: string | null;
	readonly launch: TestDebugLaunch | null;
}

export interface TestSnapshot {
	readonly operationId: string;
	readonly kind: 'discovery' | 'run' | 'debug';
	readonly status: TestOperationStatus;
	readonly tests: readonly TestItem[];
	readonly results: readonly TestResult[];
	readonly error: string | null;
	readonly sequence: number;
	readonly launch: TestDebugLaunch | null;
}

/** Execution and results belong to the backend; subscribe before starting an operation ID. */
export interface ITestExecutionService {
	readonly onDidUpdate: Event<TestUpdate>;
	readonly onDidDisconnect: Event<void>;
	discover(operationId: string, dirId: string): Promise<void>;
	run(operationId: string, dirId: string, catalogId: string, testIds: readonly string[]): Promise<void>;
	prepareDebug(operationId: string, dirId: string, catalogId: string, testId: string): Promise<void>;
	read(operationId: string): Promise<TestSnapshot>;
	cancel(operationId: string): Promise<TestSnapshot>;
	release(operationId: string): Promise<void>;
}

export const ITestExecutionService = createServiceIdentifier<ITestExecutionService>('testExecutionService');
