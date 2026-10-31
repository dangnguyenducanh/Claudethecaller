
## Verifier round 1 (T6.3): checks.mjs D4 fixed
- What: `show()` (checks.mjs:26) now catches `JSON.stringify` errors and returns '[unserializable]'.
- Why: D4 builds an assert message with `show(circ)` for a circular object; `JSON.stringify` threw `Converting circular structure to JSON` inside the check itself, before `parseWorkflow(circ)` was judged. Planner mistake, not a module defect.
- Reproducer: `node --experimental-strip-types` calling `C.parseWorkflow(circ)` with `circ.self = circ` returns `{ok:false, errors:['nodes must be a list']}`; the old check failed with the stringify TypeError.
