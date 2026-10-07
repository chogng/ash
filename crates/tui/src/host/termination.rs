use std::io;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

#[cfg(unix)]
use signal_hook::SigId;
#[cfg(unix)]
use signal_hook::consts::SIGINT;
#[cfg(unix)]
use signal_hook::consts::SIGTERM;

#[derive(Clone)]
pub(crate) struct TerminationRequest {
    requested: Arc<AtomicBool>,
}

impl TerminationRequest {
    pub(crate) fn take(&self) -> bool {
        self.requested.swap(false, Ordering::AcqRel)
    }

    #[cfg(test)]
    fn request(&self) {
        self.requested.store(true, Ordering::Release);
    }
}

pub(crate) struct TerminationSource {
    request: TerminationRequest,
    #[cfg(unix)]
    ids: Vec<SigId>,
}

impl TerminationSource {
    pub(crate) fn register() -> Result<Self, io::Error> {
        let source = Self {
            request: TerminationRequest {
                requested: Arc::new(AtomicBool::new(false)),
            },
            #[cfg(unix)]
            ids: Vec::new(),
        };
        #[cfg(unix)]
        let mut source = source;
        #[cfg(unix)]
        for signal in [SIGINT, SIGTERM] {
            let id = signal_hook::flag::register(signal, Arc::clone(&source.request.requested))?;
            source.ids.push(id);
        }
        Ok(source)
    }

    pub(crate) fn request(&self) -> TerminationRequest {
        self.request.clone()
    }
}

#[cfg(unix)]
impl Drop for TerminationSource {
    fn drop(&mut self) {
        for id in self.ids.drain(..) {
            signal_hook::low_level::unregister(id);
        }
    }
}

#[cfg(test)]
#[path = "termination_tests.rs"]
mod tests;
