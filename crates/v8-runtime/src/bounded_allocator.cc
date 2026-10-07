#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include "v8-array-buffer.h"

namespace {
// Delegate storage to V8's sandbox allocator. Returning ordinary malloc memory here would
// put backing stores outside the engine sandbox even if the byte accounting were correct.
class BoundedAllocator final : public v8::ArrayBuffer::Allocator {
 public:
  explicit BoundedAllocator(size_t limit)
      : inner_(NewDefaultAllocator()), limit_(limit) {}

  void* Allocate(size_t length) override { return AllocateBytes(length, true); }
  void* AllocateUninitialized(size_t length) override {
    return AllocateBytes(length, false);
  }
  void Free(void* data, size_t length) override {
    inner_->Free(data, length);
    used_.fetch_sub(length, std::memory_order_relaxed);
  }
  size_t MaxAllocationSize() const override {
    return std::min(limit_, inner_->MaxAllocationSize());
  }
  v8::PageAllocator* GetPageAllocator() override { return inner_->GetPageAllocator(); }

 private:
  void* AllocateBytes(size_t length, bool zeroed) {
    size_t used = used_.load(std::memory_order_relaxed);
    do {
      if (length > limit_ - used) {
        // Returning nullptr makes V8 repeatedly grow/collect its heap while retrying an
        // allocation that cannot succeed. Retire this process at the hard budget instead;
        // the supervisor removes its callbacks and starts a fresh authorized incarnation.
        std::fputs("JavaScript extension host: ArrayBuffer quota exceeded\n", stderr);
        std::_Exit(1);
      }
    } while (!used_.compare_exchange_weak(used, used + length, std::memory_order_relaxed));
    void* data = zeroed ? inner_->Allocate(length) : inner_->AllocateUninitialized(length);
    if (!data) used_.fetch_sub(length, std::memory_order_relaxed);
    return data;
  }
  std::unique_ptr<v8::ArrayBuffer::Allocator> inner_;
  const size_t limit_;
  std::atomic<size_t> used_{0};
};
}  // namespace

extern "C" v8::ArrayBuffer::Allocator* ash_bounded_array_buffer_allocator(size_t limit) {
  return new BoundedAllocator(limit);
}
