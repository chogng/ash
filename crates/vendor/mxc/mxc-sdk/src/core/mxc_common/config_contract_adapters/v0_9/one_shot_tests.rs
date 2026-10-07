// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use super::{contract, into_common_request_ir, wire};

#[path = "one_shot_tests/common.rs"]

mod common;
#[path = "one_shot_tests/isolation_session.rs"]
mod isolation_session;
#[path = "one_shot_tests/stable_candidate.rs"]
mod stable_candidate;
#[path = "one_shot_tests/wslc.rs"]
mod wslc;
