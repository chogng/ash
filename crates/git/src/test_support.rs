use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

pub struct TestRepository {
    root: PathBuf,
}

impl TestRepository {
    pub fn init() -> Self {
        let root = unique_test_path("repository");
        std::fs::create_dir_all(&root).expect("create test repository");
        let root = dunce::canonicalize(root).expect("canonicalize test repository");
        let repository = Self { root };
        repository.git(&["init", "--initial-branch=main"]);
        repository.configure();
        repository
    }

    pub fn clone_from(remote: &Path) -> Self {
        let root = unique_test_path("clone");
        let output = Command::new("git")
            .args(["-c", disabled_hooks_config()])
            .args(["-c", "core.autocrlf=false"])
            .arg("clone")
            .arg(remote)
            .arg(&root)
            .output()
            .expect("clone test repository");
        assert!(
            output.status.success(),
            "git clone failed\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let root = dunce::canonicalize(root).expect("canonicalize cloned test repository");
        let repository = Self { root };
        repository.configure();
        repository
    }

    fn configure(&self) {
        self.git(&["config", "user.name", "Ash Test"]);
        self.git(&["config", "user.email", "ash@example.invalid"]);
        self.git(&["config", "commit.gpgsign", "false"]);
        self.git(&["config", "core.autocrlf", "false"]);
        self.git(&["config", "core.eol", "lf"]);
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn relocate(&mut self) -> PathBuf {
        let destination = unique_test_path("moved-repository");
        std::fs::rename(&self.root, &destination).expect("move test repository");
        self.root = dunce::canonicalize(destination).expect("canonicalize moved repository");
        self.root.clone()
    }

    pub fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }

    pub fn write(&self, relative: &str, contents: &str) {
        let path = self.path(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create test file parent");
        }
        std::fs::write(path, contents).expect("write test file");
    }

    pub fn read(&self, relative: &str) -> String {
        std::fs::read_to_string(self.path(relative)).expect("read test file")
    }

    pub fn commit_all(&self, message: &str) {
        self.git(&["add", "--all"]);
        self.git(&["commit", "-m", message]);
    }

    pub fn git(&self, args: &[&str]) -> String {
        self.git_raw(args).trim().to_string()
    }

    pub fn git_raw(&self, args: &[&str]) -> String {
        run_git(&self.root, args)
    }
}

impl Drop for TestRepository {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

pub struct TestBareRepository {
    root: PathBuf,
}

impl TestBareRepository {
    pub fn init() -> Self {
        let root = unique_test_path("bare");
        std::fs::create_dir_all(&root).expect("create bare repository directory");
        let root = dunce::canonicalize(root).expect("canonicalize bare repository");
        let repository = Self { root };
        repository.git(&["init", "--bare", "--initial-branch=main"]);
        repository
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn git(&self, args: &[&str]) -> String {
        run_git(&self.root, args).trim().to_string()
    }
}

impl Drop for TestBareRepository {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn unique_test_path(kind: &str) -> PathBuf {
    let sequence = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "ash-git-{kind}-{}-{timestamp}-{sequence}",
        std::process::id()
    ))
}

fn run_git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(root)
        .args(["-c", disabled_hooks_config()])
        .args(args)
        .output()
        .expect("run test Git command");
    assert!(
        output.status.success(),
        "git {args:?} failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("Git test output is UTF-8")
}

fn disabled_hooks_config() -> &'static str {
    if cfg!(windows) {
        "core.hooksPath=NUL"
    } else {
        "core.hooksPath=/dev/null"
    }
}
