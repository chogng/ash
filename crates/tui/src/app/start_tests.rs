use super::process_resource_targets;
use crate::AppServerProcess;
use ash_memory_diagnostics::ProcessResourceTargets;

#[test]
fn included_server_resources_are_already_counted_in_the_tui_process() {
    assert_eq!(
        process_resource_targets(AppServerProcess::IncludedInTui),
        ProcessResourceTargets::Current
    );
}

#[test]
fn local_server_resources_are_sampled_as_a_separate_process() {
    assert_eq!(
        process_resource_targets(AppServerProcess::Local(42)),
        ProcessResourceTargets::CurrentAndTree(42)
    );
}

#[test]
fn remote_server_resources_are_not_sampled_on_the_local_host() {
    assert_eq!(
        process_resource_targets(AppServerProcess::Remote),
        ProcessResourceTargets::Current
    );
}
