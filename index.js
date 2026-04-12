import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const PORT = process.env.PORT || 3000;

if (!GITHUB_TOKEN) {
  console.error('ERROR: GITHUB_TOKEN environment variable is required');
  process.exit(1);
}

// GitHub REST API helper
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

// Create a fresh MCP server instance per connection
function createServer() {
  const server = new McpServer({ name: 'revalio-github', version: '1.0.0' });

  server.tool(
    'get_file_contents',
    'Read a file from a GitHub repository',
    {
      owner: z.string().describe('Repo owner, e.g. Arnauddl2201'),
      repo:  z.string().describe('Repo name, e.g. revalio-plugins'),
      path:  z.string().describe('File path, e.g. plugin-library/skills/foo/SKILL.md'),
      branch: z.string().optional().describe('Branch (default: main)')
    },
    async ({ owner, repo, path, branch = 'main' }) => {
      const data = await gh('GET', `/repos/${owner}/${repo}/contents/${path}?ref=${branch}`);
      const content = Buffer.from(data.content, 'base64').toString('utf8');
      return {
        content: [{ type: 'text', text: JSON.stringify({ content, sha: data.sha }) }]
      };
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
        ref: `refs/heads/${branch}`,
        sha
      });
      return {
        content: [{ type: 'text', text: `Branch '${branch}' created from '${from_branch}' at ${sha}` }]
      };
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
      const ref    = await gh('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
      const headSha = ref.object.sha;
      const headCommit = await gh('GET', `/repos/${owner}/${repo}/git/commits/${headSha}`);
      const baseTreeSha = headCommit.tree.sha;

      const treeItems = await Promise.all(files.map(async (f) => {
        const blob = await gh('POST', `/repos/${owner}/${repo}/git/blobs`, {
          content:  Buffer.from(f.content).toString('base64'),
          encoding: 'base64'
        });
        return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha };
      }));

      const tree = await gh('POST', `/repos/${owner}/${repo}/git/trees`, {
        base_tree: baseTreeSha,
        tree: treeItems
      });

      const newCommit = await gh('POST', `/repos/${owner}/${repo}/git/commits`, {
        message: commit_message,
        tree:    tree.sha,
        parents: [headSha]
      });

      await gh('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
        sha: newCommit.sha
      });

      return {
        content: [{ type: 'text', text: `✓ ${files.length} file(s) committed to '${branch}'\nCommit: ${newCommit.sha}` }]
      };
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
      return {
        content: [{ type: 'text', text: `✓ PR #${pr.number} created: ${pr.html_url}` }]
      };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

const sessions = new Map();

app.get('/sse', async (req, res) => {
  const server    = createServer();
  const transport = new SSEServerTransport('/messages', res);
  sessions.set(transport.sessionId, transport);
  res.on('close', () => sessions.delete(transport.sessionId));
  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  const transport = sessions.get(req.query.sessionId);
  if (!transport) {
    return res.status(404).json({ error: 'Session not found' });
  }
  await transport.handlePostMessage(req, res);
});

app.get('/', (req, res) => res.json({ status: 'ok', name: 'revalio-github-mcp' }));

app.listen(PORT, () => {
  console.log(`revalio-github-mcp listening on port ${PORT}`);
});
