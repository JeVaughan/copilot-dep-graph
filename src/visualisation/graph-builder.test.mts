import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph } from "../../dist/visualisation/graph-builder.js";
import { createVizState } from "../../dist/visualisation/state.js";
import { STATUS_COLOR } from "../../dist/visualisation/colors.js";

function node(id, type, parent, status) {
  return parent ? { id, type, parent, status } : { id, type, status };
}

function edge(src, tar, type, status, count = 1) {
  return { src, tar, type, status, count };
}

test("buildGraph: nests a file -> class -> method chain, computing depth and per-level scale", () => {
  const state = createVizState();
  state.graphData = {
    nodes: [
      node("a.ts", "file"),
      node("a.ts:::Foo", "class", "a.ts", "added"),
      node("a.ts:::Foo.bar", "method", "a.ts:::Foo", "added"),
    ],
    edges: [],
  };
  state.expandLevel.set("a.ts", 1);
  state.expandLevel.set("a.ts:::Foo", 1);

  const graph = buildGraph(state);

  const byId = new Map(graph.allNodes.map(n => [n.id, n]));
  assert.equal(byId.size, 3);
  assert.equal(byId.get("a.ts")._type, "file");
  assert.equal(byId.get("a.ts:::Foo")._type, "symbol");
  assert.equal(byId.get("a.ts:::Foo.bar")._type, "symbol");

  assert.equal(graph.containerDepth.get("a.ts"), 0);
  assert.equal(graph.containerDepth.get("a.ts:::Foo"), 1);
  assert.equal(graph.containerDepth.get("a.ts:::Foo.bar"), 2);

  // The method's scale should be strictly smaller than the class's, which in turn
  // is smaller than the file's (depthScale is strictly decreasing until its floor).
  assert.ok(byId.get("a.ts:::Foo.bar")._scale < byId.get("a.ts:::Foo")._scale);
  assert.ok(byId.get("a.ts:::Foo")._scale < byId.get("a.ts")._scale);

  // Both the file and the class register the method transitively in groupSymbols,
  // not just the method's immediate parent.
  assert.deepEqual(state.groupSymbols.get("a.ts").map(n => n.id).sort(), ["a.ts:::Foo", "a.ts:::Foo.bar"]);
  assert.deepEqual(state.groupSymbols.get("a.ts:::Foo").map(n => n.id), ["a.ts:::Foo.bar"]);
});

test("buildGraph: a collapsed container's children stay hidden", () => {
  const state = createVizState();
  state.graphData = {
    nodes: [node("a.ts", "file"), node("a.ts:::Foo", "class", "a.ts", "added")],
    edges: [],
  };
  // No expandLevel set for a.ts -> stays at the default (0, collapsed).

  const graph = buildGraph(state);

  assert.equal(graph.allNodes.length, 1);
  assert.equal(graph.allNodes[0].id, "a.ts");
});

test("buildGraph: reuses a prior simulation's node positions instead of re-randomizing them", () => {
  const state = createVizState();
  state.graphData = { nodes: [node("a.ts", "file"), node("b.ts", "file")], edges: [] };
  state.simulation = {
    stop() {},
    nodes: () => [{ id: "a.ts", x: 111, y: 222 }],
  };

  const graph = buildGraph(state);

  assert.equal(graph.isFirstRender, false);
  const a = graph.allNodes.find(n => n.id === "a.ts");
  assert.equal(a.x, 111);
  assert.equal(a.y, 222);
});

test("buildGraph: isFirstRender is true only when there's no prior simulation", () => {
  const state = createVizState();
  state.graphData = { nodes: [node("a.ts", "file")], edges: [] };

  assert.equal(buildGraph(state).isFirstRender, true);
});

test("buildGraph: degreeMap counts rendered links per node, and borderColor aggregates their statuses", () => {
  const state = createVizState();
  state.graphData = {
    nodes: [node("a.ts", "file"), node("b.ts", "file"), node("c.ts", "file")],
    edges: [
      edge("a.ts", "b.ts", "import", "added"),
      edge("a.ts", "c.ts", "import", "unchanged"),
    ],
  };

  const graph = buildGraph(state);

  assert.equal(graph.degreeMap.get("a.ts"), 2);
  assert.equal(graph.degreeMap.get("b.ts"), 1);
  assert.equal(graph.degreeMap.get("c.ts"), 1);

  // a.ts touches both an "added" and an "unchanged" edge -> aggregates to "added".
  assert.equal(graph.borderColor("a.ts"), STATUS_COLOR.added);
  assert.equal(graph.borderColor("b.ts"), STATUS_COLOR.added);
  assert.equal(graph.borderColor("c.ts"), STATUS_COLOR.unchanged);
});
