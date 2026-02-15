# Ralph Control UI

React UI to monitor Ralph processes (Gemini/Codex) and start/stop runs directly from the interface.

## Features

- View active processes for both providers (`ralph-gemini-loop.sh`, `ralph_loop.sh`, `ralph --`, provider CLI)
- Switch provider (`gemini` / `codex`) directly in the UI
- Persist selected provider in browser `localStorage`
- Run Ralph in a target project with custom arguments
- Stop a process by PID
- Inspect `status.json`, provider logs (`ralph-gemini.log` or `ralph.log`), and `fix_plan.md`

## Screenshot

![Ralph Control UI](docs/assets/ui-screenshot.png)

## Usage

```bash
npm install
npm run dev
```

- Frontend: http://localhost:5173
- API: http://localhost:3001

## Notes

- By default, the backend starts with provider `gemini`.
- Default scripts are resolved from the workspace:
  - `ralph-codex/ralph_loop.sh` (codex)
  - `packages/ralph-gemini/bin/ralph-gemini-loop.sh` (gemini)
- Provider capabilities are exposed by API route `GET /api/providers`.
- To work properly, the target project must have `.ralph/` enabled.
