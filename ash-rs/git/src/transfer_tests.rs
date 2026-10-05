use super::*;
use crate::test_support::TestRepository;

#[tokio::test]
async fn task_pack_preserves_binary_disk_tree_and_both_real_indexes() {
    let source = TestRepository::init();
    source.write("tracked", "base\n");
    source.commit_all("base");
    let target = TestRepository::clone_from(source.root());
    let git = GitClient::system();
    let src = git.open_repository(source.root()).await.unwrap();
    let dst = git.open_repository(target.root()).await.unwrap();
    let base = git.resolve_commit(&src, "HEAD").await.unwrap();
    source.write("tracked", "staged\n");
    source.git(&["add", "tracked"]);
    source.write("tracked", "unstaged\n");
    std::fs::write(source.path("new binary"), [0, 255, 1, 0, 129]).unwrap();
    target.write("tracked", "Mac work\n");
    target.git(&["add", "tracked"]);
    let src_index = source.git(&["write-tree"]);
    let dst_index = target.git(&["write-tree"]);
    let tree = git.capture_worktree_tree(&src).await.unwrap();
    let pack = git
        .export_task_pack(&src, &base, &tree, GitPackBase::ExistingCommit(&base))
        .await
        .unwrap();
    git.import_task_pack(&dst, &base, &tree, pack.clone())
        .await
        .unwrap();
    git.import_task_pack(&dst, &base, &tree, pack)
        .await
        .unwrap();
    assert_eq!(source.git(&["write-tree"]), src_index);
    assert_eq!(target.git(&["write-tree"]), dst_index);
    assert_eq!(target.read("tracked"), "Mac work\n");
    assert_eq!(
        target.git(&["show", &format!("{}:tracked", tree.as_str())]),
        "unstaged"
    );
    let blob = target.git(&["rev-parse", &format!("{}:new binary", tree.as_str())]);
    assert_eq!(
        git.read_blob(&dst, &blob, 16).await.unwrap(),
        (vec![0, 255, 1, 0, 129], false)
    );
}

#[tokio::test]
async fn complete_task_pack_transfers_head_and_rejects_corruption_and_gitlinks() {
    let source = TestRepository::init();
    source.write("a", "a");
    source.commit_all("a");
    let target = TestRepository::init();
    let git = GitClient::system();
    let src = git.open_repository(source.root()).await.unwrap();
    let dst = git.open_repository(target.root()).await.unwrap();
    let head = git.resolve_commit(&src, "HEAD").await.unwrap();
    let tree = git.capture_worktree_tree(&src).await.unwrap();
    let pack = git
        .export_task_pack(&src, &head, &tree, GitPackBase::Complete)
        .await
        .unwrap();
    git.import_task_pack(&dst, &head, &tree, pack.clone())
        .await
        .unwrap();
    assert!(git.contains_commit(&dst, &head).await.unwrap());
    let mut broken = pack;
    broken[8] ^= 0xff;
    assert!(
        git.import_task_pack(&dst, &head, &tree, broken)
            .await
            .is_err()
    );
    source.git(&[
        "update-index",
        "--add",
        "--cacheinfo",
        &format!("160000,{head},child"),
    ]);
    let linked = GitTreeId::new(source.git(&["write-tree"])).unwrap();
    assert!(
        git.export_task_pack(&src, &head, &linked, GitPackBase::Complete)
            .await
            .is_err()
    );
}
