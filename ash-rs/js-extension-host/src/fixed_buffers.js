(() => {
    'use strict';
    const Constructor = ArrayBuffer;
    const construct = Reflect.construct;
    function FixedArrayBuffer(length) {
        if (!new.target) throw new TypeError('ArrayBuffer requires new');
        if (arguments[1] !== undefined) throw new TypeError('Resizable ArrayBuffer is unavailable in extensions');
        return construct(Constructor, [length], new.target);
    }
    Object.defineProperties(FixedArrayBuffer, {
        name: { value: 'ArrayBuffer' },
        prototype: { value: Constructor.prototype },
        isView: { value: Constructor.isView },
        [Symbol.species]: { get() { return this; } },
    });
    Object.defineProperty(Constructor.prototype, 'constructor', {
        value: FixedArrayBuffer, writable: true, configurable: true,
    });
    globalThis.ArrayBuffer = FixedArrayBuffer;
    // Neither API is part of the extension contract. Both can allocate backing stores
    // through the isolate group's page allocator, outside the fixed-buffer budget.
    if (!Reflect.deleteProperty(globalThis, 'SharedArrayBuffer') ||
        !Reflect.deleteProperty(globalThis, 'WebAssembly')) {
        throw new Error('Unable to exclude unbudgeted memory APIs');
    }
})();
