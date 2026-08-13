import { test } from "node:test";
import assert from "node:assert/strict";
import { startViewer } from "../dist/index.mjs";

test("startViewer serves the graph UI, data, and static assets", async () => {
  const viewer = await startViewer({
    title: "Test Graph",
    nodes: [
      { id: "a.ts", type: "file", status: "added" },
      { id: "b.ts", type: "file", status: "modified" },
    ],
    edges: [{ src: "a.ts", tar: "b.ts", status: "added", type: "import" }],
  });

  try {
    assert.match(viewer.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

    const html = await (await fetch(viewer.url)).text();
    assert.ok(html.includes("<title>Dependency Graph</title>"));
    assert.ok(!html.includes("__GRAPH_DATA__"), "HTML shell should not embed graph data directly");

    const clientJs = await (await fetch(viewer.url + "graph-client.js")).text();
    assert.ok(clientJs.includes('"a.ts"'), "graph-client.js should have the graph data substituted in");
    assert.ok(!clientJs.includes("__GRAPH_DATA__"), "placeholder should be fully substituted");

    const d3res = await fetch(viewer.url + "d3.min.js");
    assert.equal(d3res.status, 200);

    const graph1 = await (await fetch(viewer.url + "graph")).json();
    assert.equal(graph1.nodes.length, 2);

    viewer.setGraph({ title: "Updated", nodes: [], edges: [] });
    const graph2 = await (await fetch(viewer.url + "graph")).json();
    assert.equal(graph2.title, "Updated");
    assert.equal(graph2.nodes.length, 0);
  } finally {
    await viewer.close();
  }
});
