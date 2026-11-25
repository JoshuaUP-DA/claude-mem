import { afterAll, beforeAll, describe, it, expect } from 'bun:test';
import express from 'express';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const mcpServerPath = fileURLToPath(new URL('../../src/servers/mcp-server.ts', import.meta.url));

type ListedTool = { name: string; inputSchema: { properties?: Record<string, unknown>; required?: string[] } };

/** tools/list and a work_state round trip from the real stdio server, against a stub worker. */
async function withServer(
  runtime: 'worker' | 'server',
  run: (client: Client, workerRequests: Array<{ path: string; body: any; query: any }>, cwd: string) => Promise<void>,
  extraEnv: Record<string, string> = {},
): Promise<void> {
  const workerRequests: Array<{ path: string; body: any; query: any }> = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { workerRequests.push({ path: req.path, body: req.body, query: req.query }); next(); });
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.post('/api/work-state/entries', (_req, res) => res.json({ entries: [] }));
  app.get('/api/work-state', (_req, res) => res.json({ entries: [] }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  // realpath: macOS reports the child's process.cwd() under /private/var.
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'claude-mem-tool-schemas-')));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpServerPath],
    cwd: dataDir,
    stderr: 'pipe',
    env: {
      ...process.env,
      CLAUDE_MEM_DATA_DIR: dataDir,
      CLAUDE_MEM_WORKER_PORT: String(port),
      CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
      CLAUDE_MEM_WORKER_AUTOSTART: 'false',
      CLAUDE_MEM_WORK_STATE_ENABLED: 'true',
      CLAUDE_MEM_RUNTIME: runtime,
      CLAUDE_MEM_SERVER_URL: `http://127.0.0.1:${port}`,
      CLAUDE_MEM_SERVER_API_KEY: 'schema-fixture-key',
      ...extraEnv,
    } as Record<string, string>,
  });
  const client = new Client({ name: 'tool-schema-fixture', version: '1' });
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport);
    await run(client, workerRequests, dataDir);
  } finally {
    await client.close();
    await transport.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe('MCP tool inputSchema declarations', () => {
  let tools: Map<string, ListedTool>;

  beforeAll(async () => {
    await withServer('server', async client => {
      tools = new Map((await client.listTools()).tools.map(tool => [tool.name, tool as ListedTool]));
    });
  }, 30_000);

  const properties = (name: string) => Object.keys(tools.get(name)?.inputSchema.properties ?? {});
  const required = (name: string) => tools.get(name)?.inputSchema.required ?? [];

  it.each([
    ['search', ['query', 'files', 'limit', 'project', 'orderBy']],
    ['timeline', ['anchor', 'query', 'depth_before', 'depth_after', 'project']],
    ['get_observations', ['ids']],
    ['session_start_context', ['project', 'projects', 'platformSource', 'full', 'colors']],
    ['observation_add', ['content']],
    ['observation_record_event', ['eventType', 'platformSource']],
    ['observation_search', ['query', 'platformSource', 'limit']],
    ['observation_context', ['query', 'platformSource']],
    ['observation_generation_status', ['jobId']],
  ])('%s declares its parameters', (name, expected) => {
    expect(properties(name)).toEqual(expect.arrayContaining(expected));
  });

  it.each([
    ['get_observations', ['ids']],
    ['work_state_write', ['list', 'fields']],
    ['observation_add', ['content']],
    ['observation_record_event', ['eventType']],
    ['observation_search', ['query']],
    ['observation_generation_status', ['jobId']],
  ])('%s requires %p', (name, expected) => {
    expect(required(name)).toEqual(expected);
  });

  it('observation_context requires nothing, so an omitted query asks for recent context (#2991)', () => {
    expect(tools.has('observation_context')).toBe(true);
    expect(required('observation_context')).toEqual([]);
  });
});

describe('work_state tools', () => {
  it('send the session cwd to the work-state routes', async () => {
    await withServer('worker', async (client, workerRequests, cwd) => {
      await client.callTool({ name: 'work_state_write', arguments: { list: 'schema-fixture', fields: { task: 'Check cwd' } } });
      await client.callTool({ name: 'work_state_read', arguments: { list: 'schema-fixture' } });
      const write = workerRequests.find(request => request.path === '/api/work-state/entries');
      const read = workerRequests.find(request => request.path === '/api/work-state');
      expect(write?.body.cwd).toBe(cwd);
      expect(read?.query.cwd).toBe(cwd);
    });
  }, 30_000);
});

describe('search by file', () => {
  it('forwards files to the worker search route without a query', async () => {
    await withServer('worker', async (client, workerRequests) => {
      await client.callTool({ name: 'search', arguments: { files: 'src/services/sync/CloudSync.ts' } });
      const search = workerRequests.find(request => request.path === '/api/search');
      expect(search?.query.files).toBe('src/services/sync/CloudSync.ts');
      expect(search?.query.query).toBeUndefined();
    });
  }, 30_000);

  it('refuses files in server runtime instead of returning unfiltered results', async () => {
    await withServer('server', async (client, workerRequests) => {
      const before = workerRequests.length;
      const result = await client.callTool({ name: 'search', arguments: { query: 'sync', files: 'src/a.ts' } }) as { isError?: boolean; content: Array<{ text?: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('Remove unsupported local filters');
      expect(workerRequests.length).toBe(before);
    }, { CLAUDE_MEM_SERVER_PROJECT_ID: 'schema-fixture-project' });
  }, 30_000);
});

describe('mcp-server source guards', () => {
  it('mcp-server skips worker auto-start when runtime=server (anti-pattern guard)', async () => {
    const src = await Bun.file(mcpServerPath).text();
    // Phase 1a (cmem-sdk rename): canonical runtime literal is `'server'`.
    // `selectRuntime()` normalizes the legacy `'server-beta'` to `'server'`.
    expect(src).toContain("selectRuntime() === 'server'");
    expect(src).toContain('skipping worker auto-start');
  });

  it('mcp-server does NOT import WorkerService (anti-pattern guard, plan line 772)', async () => {
    const src = await Bun.file(mcpServerPath).text();
    expect(src).not.toMatch(/from\s+['"][^'"]*WorkerService[^'"]*['"]/);
    expect(src).not.toMatch(/import\s+\{[^}]*WorkerService[^}]*\}/);
  });
});
