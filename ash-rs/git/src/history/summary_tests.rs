use super::GitCommitSummary;
use super::parse_commits;
use crate::GitClient;
use crate::test_support::TestRepository;
use pretty_assertions::assert_eq;
use std::num::NonZeroUsize;
#[tokio::test(flavor = "current_thread")]
async fn returns_bounded_recent_commit_summaries() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "one\n");
    repository.commit_all("first");
    repository.write("tracked.txt", "two\n");
    repository.commit_all("second");
    let latest_oid = repository.git(&["rev-parse", "HEAD"]);
    let latest_timestamp = repository
        .git(&["show", "-s", "--format=%ct", "HEAD"])
        .parse()
        .expect("timestamp");

    let client = GitClient::system();
    let opened = client
        .open_repository(repository.root())
        .await
        .expect("open repository");
    let commits = client
        .recent_commits(&opened, NonZeroUsize::new(1).expect("non-zero"))
        .await
        .expect("recent commits");

    assert_eq!(
        commits,
        vec![GitCommitSummary {
            object_id: latest_oid,
            parent_object_ids: vec![repository.git(&["rev-parse", "HEAD^"])],
            timestamp_seconds: latest_timestamp,
            subject: "second".to_string(),
        }]
    );
}

#[test]
fn commit_parser_preserves_an_empty_subject_field() {
    let commits = parse_commits(b"abc\0parent-one parent-two\0\x31\x32\x33\0\0", "git log")
        .expect("parse commits");

    assert_eq!(
        commits,
        vec![GitCommitSummary {
            object_id: "abc".to_string(),
            parent_object_ids: vec!["parent-one".to_string(), "parent-two".to_string()],
            timestamp_seconds: 123,
            subject: String::new(),
        }]
    );
}
