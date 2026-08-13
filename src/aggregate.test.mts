import { test } from "node:test";
import assert from "node:assert/strict";
import { computeVisibleNodeIds, buildLinks, visibleChildren, nextExpandLevel } from "../dist/aggregate.mjs";

function node(id, type, parent, status) {
  return parent ? { id, type, parent, status } : { id, type, status };
}

test("visibleChildren: none at 0, changed only at 1, everything at 2", () => {
  const children = [
    { id: "a", status: "unchanged" },
    { id: "b", status: "added" },
    { id: "c", status: "removed" },
  ];
  assert.deepEqual(visibleChildren(children, 0), []);
  assert.deepEqual(visibleChildren(children, 1).map(c => c.id), ["b", "c"]);
  assert.deepEqual(visibleChildren(children, 2).map(c => c.id), ["a", "b", "c"]);
});

test("nextExpandLevel: normal cycle 0 -> 1 -> 2 -> 0 when both changed and unchanged exist", () => {
  assert.equal(nextExpandLevel(0, 2, 3), 1);
  assert.equal(nextExpandLevel(1, 2, 3), 2);
  assert.equal(nextExpandLevel(2, 2, 3), 0);
});

test("nextExpandLevel: skips level 1 when there are no changed symbols (goes straight to 2)", () => {
  assert.equal(nextExpandLevel(0, 0, 5), 2);
});

test("nextExpandLevel: skips level 2 when there are no unchanged symbols (collapses from 1)", () => {
  assert.equal(nextExpandLevel(1, 5, 0), 0);
});

test("nextExpandLevel: a file with no symbols at all never expands", () => {
  assert.equal(nextExpandLevel(0, 0, 0), 0);
});

test("computeVisibleNodeIds: files always visible, symbols only when expanded and changed", () => {
  const nodes = [
    node("a.ts", "file", undefined, "modified"),
    node("a.ts:::unchangedFn", "function", "a.ts", "unchanged"),
    node("a.ts:::changedFn", "function", "a.ts", "modified"),
    node("b.ts", "file", undefined, "added"),
    node("b.ts:::newFn", "function", "b.ts", "added"),
  ];

  const collapsed = computeVisibleNodeIds(nodes, new Map());
  assert.deepEqual([...collapsed].sort(), ["a.ts", "b.ts"]);

  const aChangedOnly = computeVisibleNodeIds(nodes, new Map([["a.ts", 1]]));
  assert.deepEqual([...aChangedOnly].sort(), ["a.ts", "a.ts:::changedFn", "b.ts"]);

  const aAll = computeVisibleNodeIds(nodes, new Map([["a.ts", 2]]));
  assert.deepEqual([...aAll].sort(), ["a.ts", "a.ts:::changedFn", "a.ts:::unchangedFn", "b.ts"]);
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
