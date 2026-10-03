import { localize2 } from '../../../../nls.js';
import './skillsSettingsContent.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { OPEN_SKILLS_COMMAND_ID } from '../../../../platform/skills/common/skillService.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';

registerAction2(class OpenSkills extends Action2 {
	constructor() { super({ id: OPEN_SKILLS_COMMAND_ID, title: localize2({ bundle: 'ash', key: 'skills.open' }, 'Open skills'), f1: true }); }
	public override async run(accessor: ServicesAccessor): Promise<void> { await accessor.get(IPreferencesService).openSettings('skills'); }
});
