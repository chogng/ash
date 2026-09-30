use crate::keymap::bindings;
use crate::nls::Text;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::search_box::SearchBoxModel;
use ash_app_server_protocol::protocol::skills::{
    SkillDiagnosticDto, SkillEnablementDto, SkillListResult,
};
use ash_protocol::SkillId;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SkillSelectionAction {
    SetEnablement {
        skill_id: SkillId,
        enablement: SkillEnablementDto,
    },
}

pub(crate) struct SkillChoices {
    pub(crate) model: ListSelectionModel,
    pub(crate) actions: BTreeMap<ListSelectionItemId, SkillSelectionAction>,
    pub(crate) diagnostics: Vec<SkillDiagnosticDto>,
}

pub(crate) fn skill_choices(catalog: &SkillListResult) -> SkillChoices {
    let mut actions = BTreeMap::new();
    let all = catalog
        .skills
        .iter()
        .enumerate()
        .map(|(index, skill)| {
            let item_id = ListSelectionItemId::new(format!("skill-{index}"));
            let enablement = match skill.enablement {
                SkillEnablementDto::Disabled => SkillEnablementDto::Enabled,
                SkillEnablementDto::Enabled => SkillEnablementDto::Disabled,
            };
            actions.insert(
                item_id.clone(),
                SkillSelectionAction::SetEnablement {
                    skill_id: skill.id.clone(),
                    enablement,
                },
            );
            let item = ListSelectionItem::new(crate::extensions::title(
                skill.id.name.as_str(),
                skill.enablement == SkillEnablementDto::Enabled,
            ))
            .with_id(item_id)
            .with_details(Text::literal(&skill.description))
            .with_description(Text::literal(&skill.description));
            if skill.enablement == SkillEnablementDto::Disabled {
                item.with_disabled_suffix()
            } else {
                item
            }
        })
        .collect::<Vec<_>>();
    SkillChoices {
        model: crate::extensions::model(crate::extensions::Tab::Skills, all)
            .with_expandable_descriptions()
            .with_activation(bindings::SKILL_TOGGLE)
            .with_search(SearchBoxModel::new("Search available skills"))
            .with_empty_message("No matching skills"),
        actions,
        diagnostics: catalog.diagnostics.clone(),
    }
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
