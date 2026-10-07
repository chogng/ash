// Shared provider contracts accept promise-like results without requiring a Promise implementation.
interface Thenable<T> extends PromiseLike<T> { }
