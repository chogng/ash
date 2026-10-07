use std::num::NonZeroU16;
use std::process::Command;

/// Canonical child proxy environment shared by the host executor and platform launchers.
pub struct ProxyEnvironment {
    http: NonZeroU16,
    socks: NonZeroU16,
}

impl ProxyEnvironment {
    pub fn new(http: NonZeroU16, socks: NonZeroU16) -> Self {
        Self { http, socks }
    }

    pub fn variables(&self) -> Vec<(&'static str, String)> {
        let http = format!("http://127.0.0.1:{}", self.http);
        let mut variables = [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "http_proxy",
            "https_proxy",
            "WS_PROXY",
            "WSS_PROXY",
            "ws_proxy",
            "wss_proxy",
        ]
        .into_iter()
        .map(|key| (key, http.clone()))
        .collect::<Vec<_>>();
        for key in ["ALL_PROXY", "all_proxy"] {
            variables.push((key, format!("socks5h://127.0.0.1:{}", self.socks)));
        }
        for key in ["NO_PROXY", "no_proxy"] {
            variables.push((key, String::new()));
        }
        variables
    }

    pub fn apply_to_command(&self, command: &mut Command) {
        command.envs(self.variables());
    }
}
