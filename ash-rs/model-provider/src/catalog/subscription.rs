//! Subscription catalog readers. Each provider owns account checks and source conversion.

mod chatgpt;
mod kimi;
mod xai;

pub(crate) use chatgpt::chatgpt_catalog_binding;
pub(crate) use kimi::kimi_catalog_binding;
pub(crate) use xai::xai_catalog_binding;
