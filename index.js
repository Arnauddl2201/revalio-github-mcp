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
  return res.json();
}

function registerTools(server) {
  server.tool('get_file_contents', 'Read a file from a GitHub repository', {
    owner: z.string(), repo: z.string(), path: z.string(),
    branch: z.string().optional()
  }, async ({ owner, repo, path, branch = 'main' }) => {
    const data = await gh('GET', `/repos/${owner}/${repo}/contents/${path}?ref=${branch}`);
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return { content: [{ type: 'text', text: JSON.stringify({ content, sha: data.sha }) }] };
  });

  server.tool('create_branch', 'Create a new branch from an existing one', {
    owner: z.string(), repo: z.string(), branch: z.string(),
    from_branch: z.string().optional()
  }, async ({ owner, repo, branch, from_branch = 'main' }) => {
    const ref = await gh('GET', `/repos/${owner}/${repo}/git/ref/heads/${from_branch}`);
    await gh('POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: ref.object.sha });
    return { content: [{ type: 'text', text: `Branch '${branch}' created from '${from_branch}'` }] };
  });

  server.tool('push_files', 'Commit files to a branch atomically', {
    owner: z.string(), repo: z.string(), branch: z.string(),
    files: z.array(z.object({ path: z.string(), content: z.string() })),
    commit_message: z.string()
  }, async ({ owner, repo, branch, files, commit_message }) => {
    const ref = await gh('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
    const headSha = ref.object.sha;
    const headCommit = await gh('GET', `/repos/${owner}/${repo}/git/commits/${headSha}`);
    const treeItems = await Promise.all(files.map(async (f) => {
      const blob = await gh('POST', `/repos/${owner}/${repo}/git/blobs`, {
        content: Buffer.from(f.content).toString('base64'), encoding: 'base64'
      });
      return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha };
    }));
    const tree = await gh('POST', `/repos/${owner}/${repo}/git/trees`, { base_tree: headCommit.tree.sha, tree: treeItems });
    const newCommit = await gh('POST', `/repos/${owner}/${repo}/git/commits`, { message: commit_message, tree: tree.sha, parents: [headSha] });
    await gh('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, { sha: newCommit.sha });
    return { content: [{ type: 'text', text: `✓ ${files.length} file(s) committed — ${newCommit.sha}` }] };
  });

  server.tool('create_pull_request', 'Open a pull request on GitHub', {
    owner: z.string(), repo: z.string(), title: z.string(),
    body: z.string(), head: z.string(), base: z.string().optional()
  }, async ({ owner, repo, title, body, head, base = 'main' }) => {
    const pr = await gh('POST', `/repos/${owner}/${repo}/pulls`, { title, body, head, base });
    return { content: [{ type: 'text', text: `✓ PR #${pr.number}: ${pr.html_url}` }] };
  });
}

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// SSE transport (legacy)
const sseSessions = new Map();
app.get('/sse', async (req, res) => {
  console.log('[SSE] New connection');
  const server = new McpServer({ name: 'revalio-github', version: '1.0.0' });
  registerTools(server);
  const transport = new SSEServerTransport('/messages', res);
  sseSessions.set(transport.sessionId, transport);
  res.on('close', () => sseSessions.delete(transport.sessionId));
  await server.connect(transport);
});
app.post('/messages', async (req, res) => {
  const transport = sseSessions.get(req.query.sessionId);
  if (!transport) return res.status(404).json({ error: 'Session not found' });
  await transport.handlePostMessage(req, res);
});

// Streamable HTTP transport (new)
const httpSessions = new Map();
app.all('/mcp', async (req, res) => {
  console.log(`[MCP Streamable] ${req.method}`);
  if (req.method === 'POST') {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && httpSessions.has(sessionId)) {
      return httpSessions.get(sessionId).handleRequest(req, res, req.body);
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { console.log('[MCP] Session:', id); httpSessions.set(id, transport); }
    });
    transport.onclose = () => httpSessions.delete(transport.sessionId);
    const server = new McpServer({ name: 'revalio-github', version: '1.0.0' });
    registerTools(server);
    await server.connect(transport);
    return transport.handleRequest(req, res, req.body);
  }
  if (req.method === 'GET') {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !httpSessions.has(sessionId)) return res.status(400).json({ error: 'Missing mcp-session-id' });
    return httpSessions.get(sessionId).handleRequest(req, res);
  }
  if (req.method === 'DELETE') {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && httpSessions.has(sessionId)) await httpSessions.get(sessionId).close();
    return res.sendStatus(200);
  }
  res.status(405).json({ error: 'Method not allowed' });
});

app.get('/', (req, res) => res.json({ status: 'ok', name: 'revalio-github-mcp', endpoints: { mcp: '/mcp', sse: '/sse' } }));
app.listen(PORT, () => {
  console.log(`revalio-github-mcp on port ${PORT} — /mcp (Streamable HTTP) + /sse (legacy)`);
});
