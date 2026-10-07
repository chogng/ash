use crate::ApprovalMode;
use serde::Serialize;

/// Shared product copy. Each UI resolves its own language without changing backend state.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalModeMessage {
    pub key: &'static str,
    pub english: &'static str,
    pub chinese: &'static str,
    pub japanese: &'static str,
    pub french: &'static str,
}

/// Permission semantics shared by desktop, Rust App and TUI; contains no key bindings.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalModeDefinition {
    pub id: ApprovalMode,
    pub label: ApprovalModeMessage,
    pub description: ApprovalModeMessage,
    pub requires_confirmation: bool,
}

impl ApprovalMode {
    pub const ALL: [Self; 3] = [Self::Auto, Self::Manual, Self::BypassPermissions];

    /// Stable ID for command arguments and UI selection; independent of localized copy.
    pub const fn id(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Auto => "auto",
            Self::BypassPermissions => "bypassPermissions",
        }
    }

    pub const fn definition(self) -> ApprovalModeDefinition {
        match self {
            Self::Manual => ApprovalModeDefinition {
                id: self,
                label: ApprovalModeMessage {
                    key: "permissions.manual.label",
                    english: "Manual",
                    chinese: "手动",
                    japanese: "手動",
                    french: "Manuel",
                },
                description: ApprovalModeMessage {
                    key: "permissions.manual.description",
                    english: "Ask you when an operation needs approval",
                    chinese: "操作需要授权时由你确认",
                    japanese: "操作に承認が必要な場合は確認します",
                    french: "Vous demander lorsqu’une opération nécessite une autorisation",
                },
                requires_confirmation: false,
            },
            Self::Auto => ApprovalModeDefinition {
                id: self,
                label: ApprovalModeMessage {
                    key: "permissions.auto.label",
                    english: "Auto",
                    chinese: "自动",
                    japanese: "自動",
                    french: "Auto",
                },
                description: ApprovalModeMessage {
                    key: "permissions.auto.description",
                    english: "Review operations automatically; ask you when uncertain",
                    chinese: "自动审核操作，无法判断时询问你",
                    japanese: "操作を自動審査し、判断できない場合は確認します",
                    french: "Examiner automatiquement les opérations ; vous demander en cas d’incertitude",
                },
                requires_confirmation: false,
            },
            Self::BypassPermissions => ApprovalModeDefinition {
                id: self,
                label: ApprovalModeMessage {
                    key: "permissions.bypassPermissions.label",
                    english: "Bypass permissions",
                    chinese: "跳过权限审批",
                    japanese: "承認をスキップ",
                    french: "Ignorer les autorisations",
                },
                description: ApprovalModeMessage {
                    key: "permissions.bypassPermissions.description",
                    english: "Skip most approvals; access limits still apply",
                    chinese: "跳过大部分审批，访问范围限制仍然有效",
                    japanese: "ほとんどの承認を省略します。アクセス制限は引き続き適用されます",
                    french: "Ignorer la plupart des autorisations ; les limites d’accès restent en vigueur",
                },
                requires_confirmation: true,
            },
        }
    }
}
