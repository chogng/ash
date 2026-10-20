//! Immutable, position-independent code images. Only compiler-owned relative
//! relocations are resolved; no address or Rust allocation crosses the ABI.

use memmap2::Mmap;
use memmap2::MmapMut;
use serde::Deserialize;
use serde::Serialize;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Image {
    pub version: u32,
    pub target: String,
    pub text: Vec<u8>,
    pub generic_entry: usize,
    pub usize_entry: Option<usize>,
    pub arity: usize,
}

pub(crate) struct Code {
    memory: Mmap,
    #[cfg(feature = "compiler")]
    generic_entry: usize,
    usize_entry: Option<usize>,
    #[cfg(feature = "compiler")]
    arity: usize,
}

pub(crate) fn target() -> Result<&'static str, String> {
    if cfg!(all(
        target_arch = "x86_64",
        target_os = "windows",
        target_env = "msvc"
    )) {
        Ok("x86_64-pc-windows-msvc")
    } else if cfg!(all(
        target_arch = "x86_64",
        target_os = "linux",
        target_env = "gnu"
    )) {
        Ok("x86_64-unknown-linux-gnu")
    } else {
        Err("native scalar code images are only implemented for x64 MSVC/GNU hosts".into())
    }
}

impl Code {
    pub(crate) fn load(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > 8 * 1024 * 1024 {
            return Err("code image exceeds byte budget".into());
        }
        let image: Image = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
        if image.version != crate::ABI_VERSION
            || image.target != target()?
            || image.text.is_empty()
            || image.text.len() > 1024 * 1024
            || image.generic_entry >= image.text.len()
            || image
                .usize_entry
                .is_some_and(|offset| offset >= image.text.len())
            || image.arity > 8
        {
            return Err("invalid native code image contract".into());
        }
        let mut memory = MmapMut::map_anon(image.text.len()).map_err(|error| error.to_string())?;
        memory.copy_from_slice(&image.text);
        // x86 has coherent instruction/data caches. Other architectures require
        // a separate cache-maintenance implementation before being admitted.
        let memory = memory.make_exec().map_err(|error| error.to_string())?;
        Ok(Self {
            memory,
            #[cfg(feature = "compiler")]
            generic_entry: image.generic_entry,
            usize_entry: image.usize_entry,
            #[cfg(feature = "compiler")]
            arity: image.arity,
        })
    }

    pub(crate) fn usize_entry(
        &self,
    ) -> Result<unsafe extern "C" fn(usize, *mut usize) -> i32, String> {
        let offset = self
            .usize_entry
            .ok_or("code image has no usize ABI entry")?;
        // SAFETY: code images are authored by the opt-in development compiler,
        // with a checked C signature. The executable mapping owns this address.
        Ok(unsafe {
            std::mem::transmute::<*const u8, unsafe extern "C" fn(usize, *mut usize) -> i32>(
                self.memory.as_ptr().add(offset),
            )
        })
    }

    #[cfg(feature = "compiler")]
    pub(crate) fn call(&self, arguments: &[u64]) -> Result<u64, String> {
        if arguments.len() != self.arity {
            return Err("code image argument count differs".into());
        }
        // SAFETY: the compiler emits the versioned array/status ABI. Both arrays
        // remain live for the synchronous call, and this Code owns executable text.
        let invoke = unsafe {
            std::mem::transmute::<*const u8, unsafe extern "C" fn(*const u64, usize, *mut u64) -> i32>(
                self.memory.as_ptr().add(self.generic_entry),
            )
        };
        let mut output = 0;
        // SAFETY: the pointers refer to the live input slice and output scalar.
        let status = unsafe { invoke(arguments.as_ptr(), arguments.len(), &raw mut output) };
        if status != 0 {
            return Err(format!(
                "native function rejected invocation (status {status})"
            ));
        }
        Ok(output)
    }
}
