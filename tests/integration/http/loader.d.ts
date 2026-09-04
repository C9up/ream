/**
 * What `loader.js` re-exports from the shipped native binary.
 *
 * The file existed and was empty, so every integration test importing it was
 * told "not a module" — which is why they sat outside the typecheck. The
 * declarations point at the generated NAPI bindings rather than restating
 * them: a second copy of a signature is a second thing to keep in step.
 */
export { HyperServer } from '../../../src/native/generated.js'
