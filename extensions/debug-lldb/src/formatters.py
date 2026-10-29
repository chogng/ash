# MSVC CodeView can expose an aggregate's child with the same type and address.
# Rust's tuple summary recursively visits that child without detecting the cycle.
# Bound that traversal while preserving the toolchain's normal field summaries.
try:
    import lldb_providers as _ash_providers
    import threading as _ash_threading
    from itertools import islice as _ash_islice

    if not getattr(_ash_providers.aggregate_field_summary, "_ash_bounded", False):
        _ash_original_summary = _ash_providers.aggregate_field_summary
        _ash_summary_state = _ash_threading.local()

        def _ash_field_summary(value, internal_dict):
            active = getattr(_ash_summary_state, "active", None)
            if active is None:
                active = _ash_summary_state.active = set()
            if not active:
                _ash_summary_state.visited = 0
            key = (value.GetLoadAddress(), value.GetType().GetName())
            if key in active or len(active) >= 8 or _ash_summary_state.visited >= 64:
                yield value.GetValue() or value.GetType().GetName() or "…"
                return
            _ash_summary_state.visited += 1
            active.add(key)
            try:
                yield from _ash_islice(_ash_original_summary(value, internal_dict), 8)
                if value.GetNumChildren() > 8:
                    yield "…"
            finally:
                active.remove(key)

        _ash_field_summary._ash_bounded = True
        _ash_providers.aggregate_field_summary = _ash_field_summary
except ImportError:
    pass
