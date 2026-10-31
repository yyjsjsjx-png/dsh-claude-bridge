import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// SSH development entry. WSS deployments supply the same environment explicitly.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
process.env.BRIDGE_REMOTE_ROOT = root
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude-config')
await import('./worker.mjs')
