use std::sync::Mutex;
use std::sync::mpsc;
use std::time::Duration;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GitFetchMode {
    Off,
    Default,
    All,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct GitFetchPolicy {
    pub(crate) autofetch: GitFetchMode,
    pub(crate) autofetch_period: u32,
}

pub(crate) enum ConfigurationChanges {
    #[cfg(test)]
    Product(mpsc::Receiver<ash_config::ConfigChange>),
    Provider(mpsc::Receiver<()>),
}

impl ConfigurationChanges {
    pub(crate) fn recv_timeout(&self, timeout: Duration) -> Result<(), mpsc::RecvTimeoutError> {
        match self {
            #[cfg(test)]
            Self::Product(receiver) => receiver.recv_timeout(timeout).map(|_| ()),
            Self::Provider(receiver) => receiver.recv_timeout(timeout),
        }
    }
}

/// Supplies effective settings; the product configuration service remains their authority.
pub(crate) trait GitConfiguration: Send + Sync {
    fn read_policy(&self) -> Result<GitFetchPolicy, String>;
    fn subscribe(&self) -> ConfigurationChanges;
}

#[cfg(test)]
impl GitConfiguration for ash_config::ConfigStore {
    fn read_policy(&self) -> Result<GitFetchPolicy, String> {
        self.read_snapshot()
            .map(|snapshot| GitFetchPolicy {
                autofetch: match snapshot.values.git.autofetch {
                    ash_config::GitAutoFetchMode::Off => GitFetchMode::Off,
                    ash_config::GitAutoFetchMode::Default => GitFetchMode::Default,
                    ash_config::GitAutoFetchMode::All => GitFetchMode::All,
                },
                autofetch_period: snapshot.values.git.autofetch_period,
            })
            .map_err(|error| error.to_string())
    }
    fn subscribe(&self) -> ConfigurationChanges {
        ConfigurationChanges::Product(self.subscribe_changes())
    }
}

#[derive(Default)]
pub(crate) struct ProviderConfiguration {
    policy: Mutex<Option<GitFetchPolicy>>,
    subscribers: Mutex<Vec<mpsc::Sender<()>>>,
}

impl ProviderConfiguration {
    pub(crate) fn set(&self, policy: GitFetchPolicy) -> Result<(), String> {
        if !(1..=86_400).contains(&policy.autofetch_period) {
            return Err("invalid automatic fetch period".into());
        }
        *self
            .policy
            .lock()
            .map_err(|_| "configuration lock poisoned")? = Some(policy);
        self.subscribers
            .lock()
            .map_err(|_| "configuration lock poisoned")?
            .retain(|sender| sender.send(()).is_ok());
        Ok(())
    }
}

impl GitConfiguration for ProviderConfiguration {
    fn read_policy(&self) -> Result<GitFetchPolicy, String> {
        self.policy
            .lock()
            .map_err(|_| "configuration lock poisoned".to_string())?
            .ok_or_else(|| "Git policy has not been configured".into())
    }
    fn subscribe(&self) -> ConfigurationChanges {
        let (sender, receiver) = mpsc::channel();
        self.subscribers
            .lock()
            .expect("configuration subscribers")
            .push(sender);
        ConfigurationChanges::Provider(receiver)
    }
}
