# Comment style

A comment is for genuinely surprising logic that isn't understandable from the code itself. The code should describe itself; when it doesn't, prefer renaming a variable/parameter to fix the ambiguity before reaching for a comment.

Cut comments that:
- Explain that a field or return value is read by another module/function later ("hover.ts reads this after render() returns").
- Explain that ordering matters because a later function mutates something ("read before D3's forceLink mutates it").
- Restate a function's behavior or a field's purpose when a better name would do the same job.
- Narrate architecture decisions already visible in the code's structure (dependency injection via an explicit state parameter, no module-level globals, etc.).

Keep comments that:
- Encode a math/geometry/physics modeling decision not inferable from the formula alone (e.g. squaring a scale factor because felt size is area, not linear extent; choosing a saturating/asymptotic curve; ellipse-vs-circle geometry).
- Decode an otherwise-opaque value's meaning (e.g. what integers 0–3 mean for an expand-level field) — this is about semantics, not about who consumes the value or when.
- Explain a conspicuous absence (e.g. why a CSS property is deliberately left unset).
