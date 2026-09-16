use std::sync::OnceLock;

/// Controls whether V8 may generate executable code at runtime.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum V8JitMode {
    #[default]
    Enabled,
    Disabled,
}

struct V8Initialization {
    _platform: v8::SharedRef<v8::Platform>,
    allocator: v8::SharedRef<v8::Allocator>,
    jit_mode: V8JitMode,
}

static V8_INITIALIZATION: OnceLock<Result<V8Initialization, String>> = OnceLock::new();

/// Initializes the process-wide V8 platform once.
pub fn initialize_v8(jit_mode: V8JitMode) -> Result<(), String> {
    match V8_INITIALIZATION.get_or_init(|| initialize_v8_with_mode(jit_mode)) {
        Ok(initialization) if initialization.jit_mode == jit_mode => Ok(()),
        Ok(initialization) => Err(format!(
            "V8 was already initialized with JIT {}",
            initialization.jit_mode.description()
        )),
        Err(error) => Err(error.clone()),
    }
}

pub(super) fn ensure_v8_initialized() -> Result<(), String> {
    match V8_INITIALIZATION.get_or_init(|| initialize_v8_with_mode(V8JitMode::Enabled)) {
        Ok(_) => Ok(()),
        Err(error) => Err(error.clone()),
    }
}

pub(super) fn array_buffer_allocator() -> v8::SharedRef<v8::Allocator> {
    V8_INITIALIZATION
        .get()
        .expect("V8 is initialized before starting a cell")
        .as_ref()
        .expect("V8 initialization succeeded")
        .allocator
        .clone()
}

fn initialize_v8_with_mode(jit_mode: V8JitMode) -> Result<V8Initialization, String> {
    if !linked_v8_sandbox_enabled() {
        return Err("Code Mode must link against sandbox-enabled V8".into());
    }
    v8::icu::set_common_data_77(deno_core_icudata::ICU_DATA)
        .map_err(|error| format!("failed to initialize ICU data: {error}"))?;
    if jit_mode == V8JitMode::Disabled {
        v8::V8::set_flags_from_string("--jitless");
    }
    let platform = v8::new_default_platform(0, false).make_shared();
    v8::V8::initialize_platform(platform.clone());
    v8::V8::initialize();
    // V8's sandbox allocator lazily initializes PartitionAlloc's process-wide pool
    // without a lock. Create it inside the OnceLock and share it across cell threads.
    let allocator = v8::new_default_allocator().make_shared();
    Ok(V8Initialization {
        _platform: platform,
        allocator,
        jit_mode,
    })
}

fn linked_v8_sandbox_enabled() -> bool {
    unsafe extern "C" {
        fn v8__V8__IsSandboxEnabled() -> bool;
    }

    // `rusty_v8` exposes this symbol even when the linked archive was built without sandboxing.
    unsafe { v8__V8__IsSandboxEnabled() }
}

impl V8JitMode {
    fn description(self) -> &'static str {
        match self {
            Self::Enabled => "enabled",
            Self::Disabled => "disabled",
        }
    }
}
