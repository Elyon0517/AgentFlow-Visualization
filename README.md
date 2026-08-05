# AgentFlow-Visualization

A generic AI-workflow visualizer: feed it a stream of events (agent/task/tool/api/llm/memory/decision nodes) and it renders a live, animated dependency graph — spawn/complete/fail animations, particles traveling along edges, a force-directed layered layout, plus Timeline (Gantt) and Logs views.

## Contents

```
web/
  lib/
    flow/               event protocol, graph state, reducer, animation, force layout, node registry
    colors.ts            color palette
    utils.ts              alphaHex helper
    canvas-config.ts      camera/beam/perf constants used by the canvas layer
    clamp-popup-position.ts
  components/agent-visualizer/
    flow-view.tsx         shell: view switching, filters, playback controls
    flow-canvas.tsx        canvas host: background, bloom, node/edge/particle rendering
    flow-node-popup.tsx    node detail inspector
    flow-timeline-panel.tsx  Gantt view
    flow-logs-panel.tsx    structured log stream view
    canvas/                shape tracing, node/edge drawing, glow/text caching
    bloom-renderer.ts, background-layer.ts, glass-card.tsx, shared-ui.tsx
  hooks/
    use-flow-run.ts        drives playback (feed events → reducer → animate → layout)
    use-flow-viewport.ts   camera pan/zoom/drag
    use-click-outside.ts
  main.tsx, index.html, vite.config.ts   dev harness
```

`web/lib/flow/mock-trading-workflow.ts` is a bundled demo scenario (an options-trading pipeline) that `flow-view.tsx` plays by default.

## Running it

```bash
cd web
npm install
npm run dev
```

Opens the visualizer at `http://localhost:5173`, playing the mock workflow.

## Tests

```bash
cd web
npm test
```

Runs the flow-engine unit tests (`web/lib/flow/*.test.ts`) via Node's built-in test runner.
