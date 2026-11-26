use sha2::Digest;
use sha2::Sha256;
use std::fs::File;
use std::io::Read;
use std::path::PathBuf;

const DATA_BYTES: usize = 10_876_560;
const DATA_SHA256: &str = include_str!("../../../third_party/v8/windows-desktop-icu.sha256");

#[repr(C, align(16))]
struct Aligned<const N: usize>([u8; N]);

// An empty ICU common-data package resolves the library's fallback symbol
// without selecting the archive member containing the full data. The host
// installs the verified Electron data before making any ICU calls.
#[unsafe(export_name = "icudt78_dat")]
static ICU_STUB: Aligned<48> = Aligned([
    32, 0, 0xda, 0x27, 20, 0, 0, 0, 0, 0, 2, 0, b'T', b'o', b'C', b'P', 1, 0, 0, 0, 0, 0, 0, 0,
    b's', b't', b'u', b'b', b'd', b'a', b't', b'a', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

pub(super) fn initialize() -> Result<(), String> {
    // Keep the definition in the link before the archive's lazy fallback member.
    std::hint::black_box(&ICU_STUB);
    let electron = std::env::var_os("ASH_ELECTRON_RUN_AS_NODE_PATH")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or("Desktop Code Mode requires the packaged Electron runtime")?;
    let path = electron.with_file_name("icudtl.dat");
    let mut file =
        File::open(&path).map_err(|error| format!("reading Desktop ICU data: {error}"))?;
    // udata_setCommonData retains this pointer and requires aligned memory.
    let mut storage = vec![0u128; DATA_BYTES.div_ceil(16)].into_boxed_slice();
    // SAFETY: the heap allocation is fully initialized, aligned to at least 16,
    // and the unique mutable slice fits entirely inside it.
    let data =
        unsafe { std::slice::from_raw_parts_mut(storage.as_mut_ptr().cast::<u8>(), DATA_BYTES) };
    file.read_exact(data)
        .map_err(|error| format!("reading Desktop ICU data: {error}"))?;
    let mut extra = [0];
    if file
        .read(&mut extra)
        .map_err(|error| format!("checking Desktop ICU data length: {error}"))?
        != 0
        || format!("{:x}", Sha256::digest(data)) != DATA_SHA256.trim()
    {
        return Err("Desktop ICU data differs from the pinned V8 data".into());
    }
    let storage = Box::leak(storage);
    // SAFETY: the verified bytes remain aligned and allocated for the process lifetime.
    let data = unsafe { std::slice::from_raw_parts(storage.as_ptr().cast::<u8>(), DATA_BYTES) };
    v8::icu::set_common_data_78(data)
        .map_err(|error| format!("initializing Desktop ICU data: {error}"))
}
