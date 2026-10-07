use super::{BlockList, BlockStatus};

#[test]
fn output_before_first_command_is_preamble() {
    let mut blocks = BlockList::new();
    blocks.append_printable_output("shell ready\n");

    assert_eq!(blocks.preamble(), "shell ready\n");
    assert!(blocks.blocks().is_empty());
}

#[test]
fn starting_a_command_completes_the_previous_block() {
    let mut blocks = BlockList::new();
    let first = blocks.start_command("echo one");
    blocks.append_printable_output("one\n");
    let second = blocks.start_command("echo two");

    assert_eq!(first.get(), 1);
    assert_eq!(second.get(), 2);
    assert_eq!(blocks.blocks()[0].status(), BlockStatus::Completed);
    assert_eq!(blocks.blocks()[0].output(), "one\n");
    assert_eq!(blocks.blocks()[1].status(), BlockStatus::Running);
}

#[test]
fn process_exit_is_recorded_on_the_active_block() {
    let mut blocks = BlockList::new();
    blocks.start_command("exit 7");
    blocks.mark_process_exited(7);

    assert_eq!(blocks.blocks()[0].status(), BlockStatus::Exited(7));
}

#[test]
fn shell_integration_completes_the_running_block() {
    let mut blocks = BlockList::new();
    blocks.start_command("echo done");
    blocks.append_printable_output("done\n");

    blocks.complete_command();

    assert_eq!(blocks.blocks()[0].status(), BlockStatus::Completed);
}

#[test]
fn submitted_command_echo_is_removed_across_output_chunks() {
    let mut blocks = BlockList::new();
    blocks.start_command("printf hello");

    blocks.append_printable_output("printf ");
    blocks.append_printable_output("hello\nhel");
    blocks.append_printable_output("lo\n");

    assert_eq!(blocks.blocks()[0].output(), "hello\n");
}

#[test]
fn non_matching_initial_output_is_preserved() {
    let mut blocks = BlockList::new();
    blocks.start_command("echo expected");

    blocks.append_printable_output("actual output\n");

    assert_eq!(blocks.blocks()[0].output(), "actual output\n");
}

#[test]
fn process_exit_flushes_an_incomplete_echo_candidate() {
    let mut blocks = BlockList::new();
    blocks.start_command("echo expected");
    blocks.append_printable_output("echo ");

    blocks.mark_process_exited(1);

    assert_eq!(blocks.blocks()[0].output(), "echo ");
}
