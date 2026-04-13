import express from 'express';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const PORT = process.env.PORT || 3000;

if (!GITHUB_TOKEN) {
  console.error('ERROR: GITHUB_TOKEN environment variable is required');
  process.exit(1);
}

// ── GitHub REST API helper ──────────────────────────────────────────────────
async function gh(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'revalio-mcp-server/1.0'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub ${method} ${path} → ${res.status}: ${err}`);
  }
  if (res.status === 204) return {};
  return res.json();
}

// ── Tool definitions (shared between both transports) ──────────────────────
function registerTools(server) {
  server.tool(
    'get_file_contents',
    'Read a file from a GitHub repository',
    {
      owner:  z.string().describe('Repo owner, e.g. Arnauddl2201'),
      repo:   z.string().describe('Repo name, e.g. revalio-plugins'),
      path:   z.string().describe('File path, e.g. plugin-library/skills/foo/SKILL.md'),
      branch: z.string().optional().describe('Branch (default: main)')
    },
    async ({ owner, repo, path, branch = 'main' }) => {
      const data = await gh('GET', `/repos/${owner}/${repo}/contents/${path}?ref=${branch}`);
      const content = Buffer.from(data.content, 'base64').toString('utf8');
      return { content: [{ type: 'text', text: JSON.stringify({ content, sha: data.sha }) }] };
    }
  );

  server.tool(
    'create_branch',
    'Create a new branch from an existing one',
    {
      owner:       z.string(),
      repo:        z.string(),
      branch:      z.string().describe('New branch name'),
      from_branch: z.string().optional().describe('Source branch (default: main)')
    },
    async ({ owner, repo, branch, from_branch = 'main' }) => {
      const ref = await gh('GET', `/repos/${owner}/${repo}/git/ref/heads/${from_branch}`);
      const sha = ref.object.sha;
      await gh('POST', `/repos/${owner}/${repo}/git/refs`, {
        ref: `refs/heads/${branch}`, sha
      });
      return { content: [{ type: 'text', text: `Branch '${branch}' created from '${from_branch}' at ${sha}` }] };
    }
  );

  server.tool(
    'push_files',
    'Commit one or more files to a branch in one atomic commit',
    {
      owner:          z.string(),
      repo:           z.string(),
      branch:         z.string().describe('Target branch (must already exist)'),
      files:          z.array(z.object({
                        path:    z.string().describe('File path in repo'),
                        content: z.string().describe('File content (UTF-8 text)')
                      })).describe('Files to commit'),
      commit_message: z.string().describe('Commit message')
    },
    async ({ owner, repo, branch, files, commit_message }) => {
      const ref        = await gh('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
      const headSha    = ref.object.sha;
      const headCommit = await gh('GET', `/repos/${owner}/${repo}/git/commits/${headSha}`);
      const baseTreeSha = headCommit.tree.sha;

      const treeItems = await Promise.all(files.map(async (f) => {
        const blob = await gh('POST', `/repos/${owner}/${repo}/git/blobs`, {
          content: Buffer.from(f.content).toString('base64'),
          encoding: 'base64'
        });
        return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha };
      }));

      const tree = await gh('POST', `/repos/${owner}/${repo}/git/trees`, {
        base_tree: baseTreeSha, tree: treeItems
      });
      const newCommit = await gh('POST', `/repos/${owner}/${repo}/git/commits`, {
        message: commit_message, tree: tree.sha, parents: [headSha]
      });
      await gh('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
        sha: newCommit.sha
      });
      return { content: [{ type: 'text', text: `✓ ${files.length} file(s) committed to '${branch}'\nCommit: ${newCommit.sha}` }] };
    }
  );

  server.tool(
    'create_pull_request',
    'Open a pull request on GitHub',
    {
      owner: z.string(),
      repo:  z.string(),
      title: z.string().describe('PR title'),
      body:  z.string().describe('PR description (markdown)'),
      head:  z.string().describe('Branch to merge FROM'),
      base:  z.string().optional().describe('Branch to merge INTO (default: main)')
    },
    async ({ owner, repo, title, body, head, base = 'main' }) => {
      const pr = await gh('POST', `/repos/${owner}/${repo}/pulls`, { title, body, head, base });
      return { content: [{ type: 'text', text: `✓ PR #${pr.number} created: ${pr.html_url}` }] };
    }
  );

  server.tool(
    'merge_pull_request',
    'Merge a pull request on GitHub',
    {
      owner:        z.string(),
      repo:         z.string(),
      pull_number:  z.number().describe('PR number to merge'),
      commit_title: z.string().optional().describe('Title for the merge commit'),
      merge_method: z.enum(['merge', 'squash', 'rebase']).optional().describe('Merge method (default: squash)')
    },
    async ({ owner, repo, pull_number, commit_title, merge_method = 'squash' }) => {
      const body = { merge_method };
      if (commit_title) body.commit_title = commit_title;
      await gh('PUT', `/repos/${owner}/${repo}/pulls/${pull_number}/merge`, body);
      return { content: [{ type: 'text', text: `✓ PR #${pull_number} merged into main` }] };
    }
  );

  server.tool(
    'delete_branch',
    'Delete a branch from a GitHub repository',
    {
      owner:  z.string(),
      repo:   z.string(),
      branch: z.string().describe('Branch name to delete')
    },
    async ({ owner, repo, branch }) => {
      await gh('DELETE', `/repos/${owner}/${repo}/git/refs/heads/${branch}`);
      return { content: [{ type: 'text', text: `✓ Branch '${branch}' deleted` }] };
    }
  );
}

// ── Express app ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// CORS — allow any origin (Cowork connects from desktop)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Transport 1 : SSE (legacy, /sse) ──────────────────────────────────────
const sseSessions = new Map();

app.get('/sse', async (req, res) => {
  console.log('[SSE] New connection from', req.ip);
  const server    = new McpServer({ name: 'revalio-github', version: '1.0.0' });
  registerTools(server);
  const transport = new SSEServerTransport('/messages', res);
  sseSessions.set(transport.sessionId, transport);
  res.on('close', () => { sseSessions.delete(transport.sessionId); console.log('[SSE] Session closed:', transport.sessionId); });
  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  const transport = sseSessions.get(req.query.sessionId);
  if (!transport) return res.status(404).json({ error: 'Session not found' });
  await transport.handlePostMessage(req, res);
});

// ── Transport 2 : Streamable HTTP (new, /mcp) ─────────────────────────────
const httpSessions = new Map();

app.all('/mcp', async (req, res) => {
  console.log(`[MCP] ${req.method} from`, req.ip);

  if (req.method === 'POST') {
    const sessionId = req.headers['mcp-session-id'];

    if (sessionId && httpSessions.has(sessionId)) {
      const transport = httpSessions.get(sessionId);
      return transport.handleRequest(req, res, req.body);
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        console.log('[MCP] Session initialized:', id);
        httpSessions.set(id, transport);
      }
    });
    transport.onclose = () => {
      httpSessions.delete(transport.sessionId);
      console.log('[MCP] Session closed:', transport.sessionId);
    };

    const server = new McpServer({ name: 'revalio-github', version: '1.0.0' });
    registerTools(server);
    await server.connect(transport);
    return transport.handleRequest(req, res, req.body);
  }

  if (req.method === 'GET') {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !httpSessions.has(sessionId)) {
      return res.status(400).json({ error: 'Missing or invalid mcp-session-id' });
    }
    const transport = httpSessions.get(sessionId);
    return transport.handleRequest(req, res);
  }

  if (req.method === 'DELETE') {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && httpSessions.has(sessionId)) {
      const transport = httpSessions.get(sessionId);
      await transport.close();
    }
    return res.sendStatus(200);
  }

  res.status(405).json({ error: 'Method not allowed' });
});

// ── Health check ───────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'ok',
  name: 'revalio-github-mcp',
  version: '1.1.0',
  endpoints: {
    streamable_http: '/mcp',
    sse_legacy:      '/sse'
  }
}));

app.listen(PORT, () => {
  console.log(`revalio-github-mcp listening on port ${PORT}`);
  console.log('  Streamable HTTP : /mcp');
  console.log('  SSE (legacy)    : /sse');
});
