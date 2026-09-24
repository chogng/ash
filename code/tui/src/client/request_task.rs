use std::io;
use std::sync::mpsc;
use std::sync::mpsc::TryRecvError;
use std::thread;
use std::thread::JoinHandle;

pub(crate) struct RequestTask<T> {
    receiver: mpsc::Receiver<T>,
    task: Option<JoinHandle<()>>,
}

impl<T> RequestTask<T>
where
    T: Send + 'static,
{
    pub(crate) fn spawn(
        name: impl Into<String>,
        request: impl FnOnce() -> T + Send + 'static,
    ) -> Result<Self, io::Error> {
        let (sender, receiver) = mpsc::sync_channel(1);
        let task = thread::Builder::new().name(name.into()).spawn(move || {
            let completion = request();
            let _ = sender.send(completion);
        })?;
        Ok(Self {
            receiver,
            task: Some(task),
        })
    }

    pub(crate) fn poll(&mut self) -> Result<Option<T>, io::Error> {
        match self.receiver.try_recv() {
            Ok(completion) => {
                self.join()?;
                Ok(Some(completion))
            }
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => {
                self.join()?;
                Err(io::Error::other(
                    "background App Server request stopped without a completion",
                ))
            }
        }
    }

    fn join(&mut self) -> Result<(), io::Error> {
        self.task
            .take()
            .map(JoinHandle::join)
            .transpose()
            .map(|_| ())
            .map_err(|_| io::Error::other("background App Server request panicked"))
    }
}

#[cfg(test)]
#[path = "request_task_tests.rs"]
mod tests;
