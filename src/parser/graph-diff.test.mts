import { test } from "node:test";
import assert from "node:assert/strict";
import { diffEdges } from "../../dist/parser/graph-diff.mjs";

function e(src, tar, type) {
  return { src, tar, type, count: 1 };
}

test("diffEdges: an edge only in the pr list is added; only in the base list is removed", () => {
  const base = [e("a.ts", "c.ts", "import")];
  const pr = [e("a.ts", "b.ts", "import")];

  const edges = diffEdges(base, pr);
  assert.equal(edges.find(x => x.tar === "b.ts").status, "added");
  assert.equal(edges.find(x => x.tar === "c.ts").status, "removed");
});

test("diffEdges: an edge present in both lists is 'unchanged', never 'modified' — edges have no content of their own to compare", () => {
  const base = [e("a.ts:::foo", "b.ts:::bar", "call")];
  const pr = [e("a.ts:::foo", "b.ts:::bar", "call")];
  assert.equal(diffEdges(base, pr)[0].status, "unchanged");
});

test("diffEdges: identity is src->tar:type — same endpoints with a different type are distinct edges", () => {
  const base = [e("a.ts", "b.ts", "import")];
  const pr = [e("a.ts", "b.ts", "import"), e("a.ts", "b.ts", "sibling")];

  const edges = diffEdges(base, pr);
  assert.equal(edges.find(x => x.type === "import").status, "unchanged");
  assert.equal(edges.find(x => x.type === "sibling").status, "added");
});
