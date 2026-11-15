import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';

export const checklistIcon = registerIcon('checklist', Lxicon.plan, localize({ bundle: 'ash.docs', key: 'checklist' }, 'Checklist'));

export const tableIcon = registerIcon('table', Lxicon.sheets, localize({ bundle: 'ash.docs', key: 'insertTable' }, 'Insert table'));
