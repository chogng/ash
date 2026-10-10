use super::lifecycle::LoggedChild;
use super::lifecycle::assert_no_open_files;
use super::lifecycle::assert_process_exited;
use super::lifecycle::quote;
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

pub struct SshDaemon {
    process: LoggedChild,
    root: PathBuf,
    launcher: PathBuf,
}

impl SshDaemon {
    pub fn start(root: &Path) -> Self {
        let root = root.join("ssh");
        std::fs::create_dir(&root).unwrap();
        for key in ["host", "client"] {
            let output = Command::new("ssh-keygen")
                .args(["-q", "-t", "ed25519", "-N", "", "-f"])
                .arg(root.join(key))
                .output()
                .unwrap();
            assert!(output.status.success(), "{output:?}");
        }
        std::fs::copy(root.join("client.pub"), root.join("authorized_keys")).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let config = root.join("sshd_config");
        std::fs::write(&config, format!(
            "Port {port}\nListenAddress 127.0.0.1\nHostKey \"{}/host\"\nAuthorizedKeysFile \"{}/authorized_keys\"\nPidFile \"{}/sshd.pid\"\nUsePAM no\nPermitUserRC no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nStrictModes no\nLogLevel VERBOSE\n",
            root.display(), root.display(), root.display()
        )).unwrap();
        let mut command = Command::new("/usr/sbin/sshd");
        command.args(["-D", "-e", "-f"]).arg(config);
        drop(listener);
        // Bind only loopback, authenticate with fixture keys, and wait for sshd's
        // listening message rather than guessing readiness with a delay.
        let process = LoggedChild::start(command, "Server listening on 127.0.0.1 port");
        let user = Command::new("id").arg("-un").output().unwrap();
        assert!(user.status.success());
        let user = String::from_utf8(user.stdout).unwrap();
        let public_key = std::fs::read_to_string(root.join("host.pub")).unwrap();
        std::fs::write(
            root.join("known_hosts"),
            format!("[127.0.0.1]:{port} {public_key}"),
        )
        .unwrap();
        std::fs::write(root.join("ssh_config"), format!(
            "Host ash-loopback\n  HostName 127.0.0.1\n  Port {port}\n  User {}\n  IdentityFile \"{}/client\"\n  IdentitiesOnly yes\n  UserKnownHostsFile \"{}/known_hosts\"\n  GlobalKnownHostsFile /dev/null\n  StrictHostKeyChecking yes\n",
            user.trim(), root.display(), root.display()
        )).unwrap();
        let launcher = root.join("ssh-client");
        std::fs::write(
            &launcher,
            format!(
                "#!/bin/sh\nexec /usr/bin/ssh -F {} \"$@\"\n",
                quote(root.join("ssh_config").to_str().unwrap())
            ),
        )
        .unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
        Self {
            process,
            root,
            launcher,
        }
    }

    pub fn executable(&self) -> &Path {
        &self.launcher
    }

    pub fn connection_processes(&self) -> Vec<u32> {
        let owned = super::lifecycle::descendant_processes(self.process.id());
        assert!(
            !owned.is_empty(),
            "sshd had no authenticated session children"
        );
        owned
    }

    pub fn stop(mut self, connection_processes: &[u32]) {
        let pid = self.process.id();
        self.process.stop();
        assert_process_exited(pid);
        for &pid in connection_processes {
            assert_process_exited(pid);
        }
        // Check observed session descendants as well as the listening process;
        // directory deletion alone cannot reveal either an orphan or a live descriptor.
        assert_no_open_files(&self.root);
    }
}
