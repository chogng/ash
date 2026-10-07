import { localize } from '../../../../nls.js';
import { type TestItemState } from '../../../../platform/testing/common/testExecutionService.js';

export function testStateLabel(state: TestItemState | undefined): string {
	switch (state) {
		case 'running': return localize('testing.state.running', 'Running');
		case 'passed': return localize('testing.state.passed', 'Passed');
		case 'failed': return localize('testing.state.failed', 'Failed');
		case 'skipped': return localize('testing.state.skipped', 'Skipped');
		case 'errored': return localize('testing.state.errored', 'Error');
		case 'cancelled': return localize('testing.state.cancelled', 'Cancelled');
		case undefined: return localize('testing.state.unset', 'Not Run');
	}
}
