use crate::Child;
use crate::MasterPty;
use crate::PtyPair;
use crate::PtySize;
use crate::PtySystem;
use crate::SlavePty;
use crate::cmdbuilder::CommandBuilder;
use crate::win::psuedocon::PsuedoCon;
use anyhow::Error;
use filedescriptor::FileDescriptor;
use filedescriptor::Pipe;
use std::os::windows::io::BorrowedHandle;
use std::os::windows::io::RawHandle;
use std::sync::Arc;
use std::sync::Mutex;
use winapi::um::wincon::COORD;

#[derive(Default)]
pub struct ConPtySystem {}

fn create_conpty_handles(
    size: PtySize,
) -> anyhow::Result<(PsuedoCon, FileDescriptor, FileDescriptor)> {
    let stdin = Pipe::new()?;
    let stdout = Pipe::new()?;
    let con = PsuedoCon::new(
        COORD {
            X: size.cols as i16,
            Y: size.rows as i16,
        },
        stdin.read,
        stdout.write,
    )?;
    Ok((con, stdin.write, stdout.read))
}

/// Owns a console whose process is created by an external launcher.
/// The launcher borrows HPCON during creation, then calls client_attached.
pub struct PreparedConPty {
    con: PsuedoCon,
    input_write: Option<FileDescriptor>,
    output_read: Option<FileDescriptor>,
}

impl PreparedConPty {
    pub fn new(size: PtySize) -> anyhow::Result<Self> {
        let (con, input_write, output_read) = create_conpty_handles(size)?;
        Ok(Self {
            con,
            input_write: Some(input_write),
            output_read: Some(output_read),
        })
    }

    /// The caller must keep this console alive through process creation.
    pub fn pseudoconsole_handle(&self) -> RawHandle {
        self.con.raw_handle().cast()
    }

    /// Releases creation resources only after the launcher has attached a client.
    pub fn client_attached(&mut self) -> anyhow::Result<()> {
        self.con.client_attached()
    }

    pub fn take_writer(&mut self) -> Option<Box<dyn std::io::Write + Send>> {
        self.input_write
            .take()
            .map(|writer| Box::new(writer) as Box<dyn std::io::Write + Send>)
    }

    pub fn take_reader(&mut self) -> Option<Box<dyn std::io::Read + Send>> {
        self.output_read
            .take()
            .map(|reader| Box::new(reader) as Box<dyn std::io::Read + Send>)
    }

    pub fn resize(&self, size: PtySize) -> anyhow::Result<()> {
        self.con.resize(COORD {
            X: size.cols as i16,
            Y: size.rows as i16,
        })
    }
}

impl PtySystem for ConPtySystem {
    fn openpty(&self, size: PtySize) -> anyhow::Result<PtyPair> {
        let (con, writable, readable) = create_conpty_handles(size)?;
        let master = ConPtyMasterPty {
            inner: Arc::new(Mutex::new(Inner {
                con,
                readable,
                writable: Some(writable),
                size,
            })),
        };
        let slave = ConPtySlavePty {
            inner: Arc::clone(&master.inner),
        };
        Ok(PtyPair {
            master: Box::new(master),
            slave: Box::new(slave),
        })
    }
}

struct Inner {
    con: PsuedoCon,
    readable: FileDescriptor,
    writable: Option<FileDescriptor>,
    size: PtySize,
}

#[derive(Clone)]
pub struct ConPtyMasterPty {
    inner: Arc<Mutex<Inner>>,
}

pub struct ConPtySlavePty {
    inner: Arc<Mutex<Inner>>,
}

impl MasterPty for ConPtyMasterPty {
    fn resize(&self, size: PtySize) -> anyhow::Result<()> {
        let mut inner = self.inner.lock().unwrap();
        inner.con.resize(COORD {
            X: size.cols as i16,
            Y: size.rows as i16,
        })?;
        inner.size = size;
        Ok(())
    }

    fn get_size(&self) -> Result<PtySize, Error> {
        Ok(self.inner.lock().unwrap().size)
    }

    fn try_clone_reader(&self) -> anyhow::Result<Box<dyn std::io::Read + Send>> {
        Ok(Box::new(self.inner.lock().unwrap().readable.try_clone()?))
    }

    fn take_writer(&self) -> anyhow::Result<Box<dyn std::io::Write + Send>> {
        Ok(Box::new(
            self.inner
                .lock()
                .unwrap()
                .writable
                .take()
                .ok_or_else(|| anyhow::anyhow!("writer already taken"))?,
        ))
    }
}

impl ConPtySlavePty {
    fn spawn(
        &self,
        cmd: CommandBuilder,
        job: Option<BorrowedHandle<'_>>,
    ) -> anyhow::Result<Box<dyn Child + Send + Sync>> {
        let mut inner = self.inner.lock().unwrap();
        let child = inner.con.spawn_command(cmd, job)?;
        Ok(Box::new(child))
    }
}

impl SlavePty for ConPtySlavePty {
    fn spawn_command(&self, cmd: CommandBuilder) -> anyhow::Result<Box<dyn Child + Send + Sync>> {
        self.spawn(cmd, None)
    }

    fn spawn_command_in_job(
        &self,
        cmd: CommandBuilder,
        job: BorrowedHandle<'_>,
    ) -> anyhow::Result<Box<dyn Child + Send + Sync>> {
        self.spawn(cmd, Some(job))
    }
}
