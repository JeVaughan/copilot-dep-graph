import { test } from "node:test";
import assert from "node:assert/strict";
import { computeVisibleNodeIds, buildLinks, visibleChildren, nextExpandLevel } from "../dist/aggregate.mjs";

function node(id, type, parent, status) {
  return parent ? { id, type, parent, status } : { id, type, status };
}

test("visibleChildren: none at 0, own-changed at 1, +edge-changed at 2, everything at 3", () => {
  const children = [
    { id: "a", status: "unchanged" }, // fully unchanged
    { id: "b", status: "added" },     // own-changed
    { id: "c", status: "removed" },   // own-changed
    { id: "d", status: "unchanged" }, // unchanged status, but touches a changed edge
  ];
  const hasChangedEdge = (id) => id === "d";

  assert.deepEqual(visibleChildren(children, 0, hasChangedEdge), []);
  assert.deepEqual(visibleChildren(children, 1, hasChangedEdge).map(c => c.id), ["b", "c"]);
  assert.deepEqual(visibleChildren(children, 2, hasChangedEdge).map(c => c.id), ["b", "c", "d"]);
  assert.deepEqual(visibleChildren(children, 3, hasChangedEdge).map(c => c.id), ["a", "b", "c", "d"]);
});

test("nextExpandLevel: normal cycle 0 -> 1 -> 2 -> 3 -> 0 when all three tiers exist", () => {
  assert.equal(nextExpandLevel(0, 2, 1, 3), 1);
  assert.equal(nextExpandLevel(1, 2, 1, 3), 2);
  assert.equal(nextExpandLevel(2, 2, 1, 3), 3);
  assert.equal(nextExpandLevel(3, 2, 1, 3), 0);
});

test("nextExpandLevel: skips level 1 when there are no own-changed children (goes straight to 2)", () => {
  assert.equal(nextExpandLevel(0, 0, 4, 5), 2);
});

test("nextExpandLevel: skips level 2 when there are no edge-changed children (goes straight to 3)", () => {
  assert.equal(nextExpandLevel(1, 5, 0, 4), 3);
});

test("nextExpandLevel: skips straight to 3 when only fully-unchanged children exist", () => {
  assert.equal(nextExpandLevel(0, 0, 0, 5), 3);
});

test("nextExpandLevel: skips level 3 when there are no fully-unchanged children (collapses from 2)", () => {
  assert.equal(nextExpandLevel(2, 5, 3, 0), 0);
});

test("nextExpandLevel: a container with no children at all never expands", () => {
  assert.equal(nextExpandLevel(0, 0, 0, 0), 0);
});

test("computeVisibleNodeIds: files always visible, symbols only when expanded and changed", () => {
  const nodes = [
    node("a.ts", "file", undefined, "modified"),
    node("a.ts:::unchangedFn", "function", "a.ts", "unchanged"),
    node("a.ts:::changedFn", "function", "a.ts", "modified"),
    node("b.ts", "file", undefined, "added"),
    node("b.ts:::newFn", "function", "b.ts", "added"),
  ];

  const collapsed = computeVisibleNodeIds(nodes, [], new Map());
  assert.deepEqual([...collapsed].sort(), ["a.ts", "b.ts"]);

  const aChangedOnly = computeVisibleNodeIds(nodes, [], new Map([["a.ts", 1]]));
  assert.deepEqual([...aChangedOnly].sort(), ["a.ts", "a.ts:::changedFn", "b.ts"]);

  const aAll = computeVisibleNodeIds(nodes, [], new Map([["a.ts", 3]]));
  assert.deepEqual([...aAll].sort(), ["a.ts", "a.ts:::changedFn", "a.ts:::unchangedFn", "b.ts"]);
});

test("computeVisibleNodeIds: an unchanged-status symbol touching a changed edge shows at level 2, before fully-unchanged siblings at level 3", () => {
  const nodes = [
    node("a.ts", "file", undefined, "modified"),
    node("a.ts:::edgeTouched", "function", "a.ts", "unchanged"),
    node("a.ts:::untouched", "function", "a.ts", "unchanged"),
    node("b.ts", "file", undefined, "added"),
    node("b.ts:::caller", "function", "b.ts", "added"),
  ];
  const edges = [
    { src: "b.ts:::caller", tar: "a.ts:::edgeTouched", type: "call", status: "added", count: 1 },
  ];

  const level1 = computeVisibleNodeIds(nodes, edges, new Map([["a.ts", 1]]));
  assert.ok(!level1.has("a.ts:::edgeTouched"), "not own-changed, so not visible yet at level 1");

  const level2 = computeVisibleNodeIds(nodes, edges, new Map([["a.ts", 2]]));
  assert.ok(level2.has("a.ts:::edgeTouched"), "touches a changed edge, so visible at level 2");
  assert.ok(!level2.has("a.ts:::untouched"), "no changed edge and no own change, so still hidden at level 2");

  const level3 = computeVisibleNodeIds(nodes, edges, new Map([["a.ts", 3]]));
  assert.ok(level3.has("a.ts:::untouched"), "fully unchanged children only show once everything else has been revealed");
});

test("buildLinks merges edges of the SAME type with different statuses (unchanged + added -> added)", () => {
  const nodes = [
    node("a.ts", "file", undefined, "modified"),
    node("a.ts:::add", "function", "a.ts", "unchanged"),
    node("a.ts:::sub", "function", "a.ts", "added"),
    node("b.ts", "file", undefined, "added"),
    node("b.ts:::x", "function", "b.ts", "unchanged"),
    node("b.ts:::y", "function", "b.ts", "added"),
  ];
  const edges = [
    { src: "b.ts:::x", tar: "a.ts:::add", type: "call", status: "unchanged", count: 1 },
    { src: "b.ts:::y", tar: "a.ts:::sub", type: "call", status: "added", count: 1 },
  ];

  const links = buildLinks(nodes, edges, new Map());
  assert.equal(links.length, 1, "both calls collapse onto the same b.ts -> a.ts pair");
  assert.equal(links[0].src, "b.ts");
  assert.equal(links[0].tar, "a.ts");
  assert.equal(links[0].count, 2);
  assert.equal(links[0].status, "added", "unchanged should not dilute the real 'added' status");
});

test("buildLinks merges a call edge and a reference edge onto the same collapsed pair (the actual bug)", () => {
  // Reproduces parsePr's real output shape: a call edge (symbol -> symbol, status
  // reflects the calling symbol) and a reference edge (file -> symbol, status null)
  // both targeting a.ts's `add`, from the same b.ts.
  const nodes = [
    node("a.ts", "file", undefined, "modified"),
    node("a.ts:::add", "function", "a.ts", "unchanged"),
    node("b.ts", "file", undefined, "added"),
    node("b.ts:::x", "function", "b.ts", "added"),
  ];
  const edges = [
    { src: "b.ts:::x", tar: "a.ts:::add", type: "call", status: "added", count: 1 },
    { src: "b.ts", tar: "a.ts:::add", type: "reference", status: null, count: 1 },
  ];

  const links = buildLinks(nodes, edges, new Map());
  assert.equal(links.length, 1, "call and reference edges collapsing onto the same pair must merge into one line");
  assert.equal(links[0].src, "b.ts");
  assert.equal(links[0].tar, "a.ts");
  assert.equal(links[0].count, 2);
  assert.equal(links[0].type, "call", "call takes priority over reference as the primary type");
  assert.equal(links[0].status, "added", "unchanged reference should not dilute the real 'added' call status");
});

test("buildLinks collapses two different real statuses (added + removed) to 'modified'", () => {
  const nodes = [
    node("a.ts", "file", undefined, "modified"),
    node("a.ts:::add", "function", "a.ts", "unchanged"),
    node("a.ts:::sub", "function", "a.ts", "unchanged"),
    node("b.ts", "file", undefined, "modified"),
    node("b.ts:::x", "function", "b.ts", "added"),
    node("b.ts:::y", "function", "b.ts", "removed"),
  ];
  const edges = [
    { src: "b.ts:::x", tar: "a.ts:::add", type: "call", status: "added", count: 1 },
    { src: "b.ts:::y", tar: "a.ts:::sub", type: "call", status: "removed", count: 1 },
  ];

  const links = buildLinks(nodes, edges, new Map());
  assert.equal(links.length, 1);
  assert.equal(links[0].status, "modified");
});

test("buildLinks keeps symbol-level edges distinct once their file is expanded", () => {
  const nodes = [
    node("a.ts", "file", undefined, "modified"),
    node("a.ts:::add", "function", "a.ts", "modified"),
    node("a.ts:::sub", "function", "a.ts", "added"),
    node("b.ts", "file", undefined, "added"),
    node("b.ts:::x", "function", "b.ts", "added"),
    node("b.ts:::y", "function", "b.ts", "added"),
  ];
  const edges = [
    { src: "b.ts:::x", tar: "a.ts:::add", type: "call", status: "added", count: 1 },
    { src: "b.ts:::y", tar: "a.ts:::sub", type: "call", status: "added", count: 1 },
  ];

  const links = buildLinks(nodes, edges, new Map([["a.ts", 1], ["b.ts", 1]]));
  assert.equal(links.length, 2, "distinct symbol pairs should not merge just because their files match");
  const pairs = links.map(l => l.src + "->" + l.tar).sort();
  assert.deepEqual(pairs, ["b.ts:::x->a.ts:::add", "b.ts:::y->a.ts:::sub"]);
});

test("computeVisibleNodeIds: a grandchild is visible only when every ancestor is itself expanded enough to reveal it", () => {
  const nodes = [
    node("a.ts", "file", undefined, "modified"),
    node("a.ts:::Widget", "class", "a.ts", "modified"),
    node("a.ts:::Widget:::run", "method", "a.ts:::Widget", "added"),
    node("a.ts:::Widget:::old", "method", "a.ts:::Widget", "unchanged"),
  ];

  assert.deepEqual([...computeVisibleNodeIds(nodes, [], new Map())].sort(), ["a.ts"]);

  // File expanded, but the class itself isn't expanded: Widget shows, its methods don't.
  const fileOnly = computeVisibleNodeIds(nodes, [], new Map([["a.ts", 1]]));
  assert.deepEqual([...fileOnly].sort(), ["a.ts", "a.ts:::Widget"]);

  // File and class both expanded to "own-changed only": the changed method shows, the
  // unchanged one doesn't.
  const both1 = computeVisibleNodeIds(nodes, [], new Map([["a.ts", 1], ["a.ts:::Widget", 1]]));
  assert.deepEqual([...both1].sort(), ["a.ts", "a.ts:::Widget", "a.ts:::Widget:::run"]);

  // Class expanded to "everything" (no edges here, so the unchanged method is fully
  // unchanged and only shows at level 3, not 2).
  const both2 = computeVisibleNodeIds(nodes, [], new Map([["a.ts", 1], ["a.ts:::Widget", 3]]));
  assert.deepEqual([...both2].sort(), ["a.ts", "a.ts:::Widget", "a.ts:::Widget:::old", "a.ts:::Widget:::run"]);
});

test("buildLinks: an edge to a hidden grandchild collapses to the nearest VISIBLE ancestor, not straight to the file", () => {
  const nodes = [
    node("a.ts", "file", undefined, "modified"),
    node("a.ts:::Widget", "class", "a.ts", "modified"),
    node("a.ts:::Widget:::run", "method", "a.ts:::Widget", "added"),
    node("b.ts", "file", undefined, "added"),
    node("b.ts:::caller", "function", "b.ts", "added"),
  ];
  const edges = [
    { src: "b.ts:::caller", tar: "a.ts:::Widget:::run", type: "call", status: "added", count: 1 },
  ];

  // a.ts expanded (Widget visible) but Widget itself collapsed (run hidden): the edge
  // should land on Widget, not skip past it straight to a.ts.
  const links = buildLinks(nodes, edges, new Map([["a.ts", 1], ["b.ts", 1]]));
  assert.equal(links.length, 1);
  assert.equal(links[0].src, "b.ts:::caller");
  assert.equal(links[0].tar, "a.ts:::Widget");

  // Neither a.ts nor Widget expanded: collapses all the way to the file.
  const collapsed = buildLinks(nodes, edges, new Map([["b.ts", 1]]));
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].tar, "a.ts");

  // Widget expanded too: resolves all the way to the method itself.
  const full = buildLinks(nodes, edges, new Map([["a.ts", 1], ["a.ts:::Widget", 1], ["b.ts", 1]]));
  assert.equal(full.length, 1);
  assert.equal(full[0].tar, "a.ts:::Widget:::run");
});

test("buildLinks: at level 1, an edge to an unchanged symbol falls back to the file (not visible yet)", () => {
  const nodes = [
    node("a.ts", "file", undefined, "modified"),
    node("a.ts:::add", "function", "a.ts", "unchanged"),
    node("b.ts", "file", undefined, "added"),
    node("b.ts:::x", "function", "b.ts", "added"),
  ];
  const edges = [
    { src: "b.ts:::x", tar: "a.ts:::add", type: "call", status: "added", count: 1 },
  ];

  // b.ts expanded at level 1 (changed only) - x is visible, but a's `add` is unchanged
  // so it's NOT visible at a.ts's level 0 -> the edge should collapse to a.ts.
  const links = buildLinks(nodes, edges, new Map([["b.ts", 1]]));
  assert.equal(links.length, 1);
  assert.equal(links[0].src, "b.ts:::x");
  assert.equal(links[0].tar, "a.ts");

  // Once a.ts is at level 2 (all symbols), the same edge should resolve symbol-to-symbol.
  const linksExpanded = buildLinks(nodes, edges, new Map([["b.ts", 1], ["a.ts", 2]]));
  assert.equal(linksExpanded.length, 1);
  assert.equal(linksExpanded[0].src, "b.ts:::x");
  assert.equal(linksExpanded[0].tar, "a.ts:::add");
});
