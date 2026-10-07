use crate::ExtensionDiagnostic;
use crate::ExtensionDiagnosticCode;
use crate::ExtensionRoot;
use crate::ExtensionRootKind;

pub(crate) fn diagnostic(
    root: &ExtensionRoot,
    subject: Option<String>,
    code: ExtensionDiagnosticCode,
    message: &'static str,
) -> ExtensionDiagnostic {
    ExtensionDiagnostic {
        source: source_label(&root.kind).into(),
        subject,
        code,
        message: message.into(),
    }
}

fn source_label(kind: &ExtensionRootKind) -> &'static str {
    match kind {
        ExtensionRootKind::BuiltIn => "builtIn",
        ExtensionRootKind::Plugin => "plugin",
        ExtensionRootKind::Marketplace => "marketplace",
        ExtensionRootKind::User => "user",
    }
}
