// An independent release executable; never included in a product package.
#[inline(always)]
fn inline_site(value: usize) -> usize {
    std::hint::black_box(value + 17)
}

#[unsafe(no_mangle)]
#[inline(never)]
pub fn ash_symbol_fixture(value: usize) -> usize {
    inline_site(value)
}

#[inline(never)]
fn crash_site() -> ! {
    std::process::abort()
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetModuleHandleW(name: *const u16) -> *const std::ffi::c_void;
}

fn main() {
    let pc = ash_symbol_fixture as *const () as usize;
    #[cfg(windows)]
    let base = unsafe { GetModuleHandleW(std::ptr::null()) } as usize;
    #[cfg(not(windows))]
    let base = 0usize;
    println!("PC={pc:x} BASE={base:x} VALUE={}", ash_symbol_fixture(25));
    if std::env::args().any(|argument| argument == "--crash") {
        panic!("controlled release symbol test");
    }
    if std::env::args().any(|argument| argument == "--abort") {
        crash_site();
    }
}
