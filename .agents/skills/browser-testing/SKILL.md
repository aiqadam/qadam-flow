# Browser Testing with agent-browser

Use `npx agent-browser` to interact with the running app in a headless browser.

## Workflow
```bash
npx agent-browser open http://localhost:8080
npx agent-browser wait --load networkidle
npx agent-browser snapshot -i          # get @refs
npx agent-browser fill @e4 "value"
npx agent-browser click @e5
npx agent-browser screenshot /tmp/screenshot.png
npx agent-browser get url
npx agent-browser close
```

## Gotchas
- `wait --load networkidle` hangs on pages with websockets/polling — use `sleep` instead
- Refs (`@e1`) invalidate after navigation — re-snapshot after page changes
- If browser hangs: `npx agent-browser close`
