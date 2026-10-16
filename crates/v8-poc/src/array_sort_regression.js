// Copyright 2026 the V8 project authors. All rights reserved.
// Use of this source code is governed by the BSD-style license in V8's LICENSE.
// Adapted from V8's regress-crbug-542403045.js:
// https://github.com/v8/v8/commit/94c34b200ae9caf83d06c167a070746a1c7e825c
// Run only in test isolates with --allow-natives-syntax. Strings keep this
// fixture parseable by ordinary JavaScript tooling.
(() => {
  const prepare = new Function("fn", "%PrepareFunctionForOptimization(fn);");
  const hasSmiElements = new Function("a", "return %HasSmiElements(a);");
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  function checkSort(optimize, isOptimized) {
    function sort(a) {
      return a.sort(() => {
        a.fill(0);
        return 0;
      });
    }
    prepare(sort);
    for (let i = 0; i < 100; i++) {
      sort([1, 2]);
      sort([{}, {}]);
    }
    optimize(sort);
    sort([1, 2]);
    const object = {};
    const result = sort([object, {}]);
    assert(!hasSmiElements(result), "sort stored objects in Smi elements");
    assert(result[0] === object, "sort lost its snapshotted object");

    function sortMixed(a) {
      return a.sort((x, y) => x - y);
    }
    prepare(sortMixed);
    for (let i = 0; i < 100; i++) {
      sortMixed([2, 1]);
      sortMixed([{}, {}]);
    }
    optimize(sortMixed);
    assert(
      sortMixed([3, 1, 2]).join() === "1,2,3",
      "mixed-kind feedback changed sort results",
    );

    function sortDouble(a) {
      return a.sort((x, y) => {
        a.fill(0);
        return x - y;
      });
    }
    prepare(sortDouble);
    for (let i = 0; i < 100; i++) {
      sortDouble([2, 1]);
      sortDouble([2.5, 1.5]);
    }
    optimize(sortDouble);
    sortDouble([2, 1]);
    assert(
      sortDouble([2.5, 1.5]).join() === "1.5,2.5",
      "sort lost its snapshotted doubles",
    );

    function withProperty() {
      const a = [{}, {}];
      a.foo = 1;
      return a;
    }
    function sortSameKind(a) {
      return a.sort(() => 0);
    }
    prepare(sortSameKind);
    for (let i = 0; i < 100; i++) {
      sortSameKind([{}, {}]);
      sortSameKind(withProperty());
    }
    optimize(sortSameKind);
    sortSameKind([{}, {}]);
    assert(isOptimized(sortSameKind), "matching kinds failed to optimize");
    for (let i = 0; i < 100; i++) {
      sortSameKind([{}, {}]);
      sortSameKind(withProperty());
    }
    assert(isOptimized(sortSameKind), "matching kinds deoptimized");
  }

  checkSort(
    new Function("fn", "%OptimizeFunctionOnNextCall(fn);"),
    new Function("fn", "return %ActiveTierIsTurbofan(fn);"),
  );
  if (new Function("return %IsMaglevEnabled();")()) {
    checkSort(
      new Function("fn", "%OptimizeMaglevOnNextCall(fn);"),
      new Function("fn", "return %ActiveTierIsMaglev(fn);"),
    );
  }
  return true;
})();
