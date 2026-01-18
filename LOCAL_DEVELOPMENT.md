# Local Development Setup

## Using the Local Build with Claude Code

If you have a local Docker Milvus container running on `localhost:19530`, follow these steps:

### 1. Remove the existing MCP configuration (if any)

```bash
claude mcp remove claude-context
```

### 2. Add the local version

```bash
claude mcp add claude-context \
  -e OPENAI_API_KEY=your-openai-api-key \
  -e MILVUS_ADDRESS=localhost:19530 \
  -- node /Users/vivekputtaparthi/WebstormProjects/claude-context/packages/mcp/dist/index.js
```

### 3. Restart Claude Code

Exit and re-open Claude Code, or use `/mcp` to verify the connection.

---

## Available Tools

### Indexing & Search
- `index_codebase` - Index a codebase for semantic search
- `search_code` - Search the indexed codebase
- `clear_index` - Clear the index
- `get_indexing_status` - Check indexing progress

### File Watching (NEW)
- `start_watching` - Enable real-time file watching for auto-reindexing
- `stop_watching` - Disable file watching
- `get_watcher_status` - Check watcher status

---

## Usage Examples

### Index a codebase
```
Index this codebase
```

### Enable file watching
```
Start watching this codebase for file changes
```

### Check watcher status
```
What's the watcher status?
```

### Stop watching
```
Stop watching this codebase
```

---

## Rebuilding After Changes

After making code changes, rebuild and restart:

```bash
pnpm build
```

Then restart Claude Code to pick up the changes.
