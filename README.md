# AgentFlow Visualization

An interactive, framework-agnostic visualizer for AI and agent workflows. Feed it a live event stream or a recorded JSONL run and it renders the execution as an animated dependency graph, a Gantt-style timeline, and structured logs.

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)

## Features

- Animated canvas graph with spawn, completion, failure, edge, and data-transfer effects
- Force-directed layered layout with pan, zoom, selection, filtering, and path focus
- Current Run, Timeline, and structured Logs views backed by the same run state
- Built-in mock options-trading workflow for immediate exploration
- Live Server-Sent Events (SSE) input with reconnection and event validation
- JSONL import, drag-and-drop replay, URL-based replay, and run export
- Framework-independent event protocol for agents, tasks, tools, APIs, LLMs, memory, decisions, data sources, and orchestrators

## Tech stack

- React 19 and TypeScript
- Vite 8
- Tailwind CSS 4
- D3 Force
- HTML Canvas

## Getting started

Requirements: Node.js 20.19+ or 22.12+, and pnpm.

```bash
pnpm install
pnpm dev
```

Open `http://localhost:5173`. The bundled demo workflow starts automatically.

Other commands:

```bash
pnpm build      # create a production build in dist/
pnpm preview    # preview the production build
pnpm test       # run the flow-engine unit tests
```

## Data sources

Use the source controls in the application, or open it with one of these query parameters:

```text
?stream=https://example.com/events   # connect to an SSE endpoint
?replay=https://example.com/run.jsonl # load a recorded run
```

Each SSE message may contain one event or an array of events. Recorded runs use one JSON event per line. A minimal event looks like this:

```json
{
  "eventId": "evt-1",
  "runId": "run-1",
  "timestamp": "2026-08-05T12:00:00.000Z",
  "eventType": "node.started",
  "node": {
    "id": "agent-1",
    "type": "agent",
    "label": "Research Agent"
  },
  "metadata": {
    "summary": "Researching the request"
  }
}
```

The complete protocol, validation rules, event types, and metadata fields are defined in [`lib/flow/events.ts`](lib/flow/events.ts).

## Project structure

```text
app/                         global styles
components/agent-visualizer/ UI, canvas renderer, timeline, and logs
hooks/                       playback, stream, and viewport React hooks
lib/flow/                    protocol, graph, reducer, animation, layout, tests
lib/                         colors, shared utilities, and canvas configuration
main.tsx                     application entry point
vite.config.ts               Vite and path-alias configuration
```

## License

Released under the [MIT License](LICENSE).
