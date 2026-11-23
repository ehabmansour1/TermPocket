// The sample project shown in the README screenshots: "my-app", a small TypeScript todo API (the same
// project the demo desktop in agent/demo/ shows). Made up for the screenshots; nothing in it is real.
//
// writeDemoWorkspace(dir) writes the files and builds a git history with uncommitted work, so the
// workbench has something to show everywhere:
//   * Source Control: src/api/routes.ts staged (M), src/server.ts modified (M),
//     src/rateLimit.ts + test/rateLimit.test.ts untracked (U);
//   * Problems: src/api/todos.ts compares a number id with a string (TS2367) and has an unused import;
//   * node_modules/ holds tiny type stubs only (express, vitest, @types/node), so the TypeScript server
//     reports just that one real problem instead of "cannot find module".

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const FILES = {
  '.gitignore': 'node_modules\ndist\ncoverage\n.env\n',
  '.prettierrc': '{\n  "singleQuote": true,\n  "semi": true,\n  "printWidth": 100\n}\n',
  'package.json': `{
  "name": "my-app",
  "version": "1.4.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p . && vite build",
    "test": "vitest",
    "lint": "eslint src test"
  },
  "dependencies": {
    "express": "^4.21.1"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^22.9.0",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vite": "^5.4.11",
    "vitest": "^2.1.4"
  }
}
`,
  'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src", "test"]
}
`,
  'vite.config.js': `import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
  build: { outDir: 'dist/web' },
});
`,
  'README.md': `# my-app

A tiny todo app: an Express API in \`src/server.ts\` and a small web UI.

\`\`\`sh
npm install
npm run dev     # API on http://localhost:3000, UI on http://localhost:5173
npm test
\`\`\`

## API

| Method | Path | |
| --- | --- | --- |
| GET | \`/api/todos\` | list todos |
| POST | \`/api/todos\` | create a todo |
| PATCH | \`/api/todos/:id\` | update a todo |
| DELETE | \`/api/todos/:id\` | delete a todo |
| GET | \`/health\` | liveness probe |
`,
  'src/server.ts': `import express from 'express';
import { createServer } from 'node:http';
import { router } from './api/routes';
import { logger } from './logger';

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(express.json());
app.use('/api', router);

// Liveness probe for the load balancer and the uptime monitor.
app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), version: '1.4.0' });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

createServer(app).listen(port, () => {
  logger.info(\`API listening on http://localhost:\${port}\`);
});

export default app;
`,
  'src/logger.ts': `type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? order.info;

function log(level: Level, ...args: unknown[]) {
  if (order[level] < min) return;
  const time = new Date().toTimeString().slice(0, 8);
  console[level === 'debug' ? 'log' : level](time, level.padEnd(5), ...args);
}

export const logger = {
  debug: (...a: unknown[]) => log('debug', ...a),
  info: (...a: unknown[]) => log('info', ...a),
  warn: (...a: unknown[]) => log('warn', ...a),
  error: (...a: unknown[]) => log('error', ...a),
};
`,
  'src/api/todos.ts': `export interface Todo {
  id: number;
  title: string;
  done: boolean;
  createdAt: Date;
}

let nextId = 1;
const todos: Todo[] = [];

export function listTodos(): Todo[] {
  return [...todos].sort((a, b) => Number(a.done) - Number(b.done) || b.createdAt.getTime() - a.createdAt.getTime());
}

export function createTodo(title: string): Todo {
  const todo: Todo = { id: nextId++, title: title.trim(), done: false, createdAt: new Date() };
  todos.push(todo);
  return todo;
}

export function findTodo(id: string): Todo | undefined {
  return todos.find((t) => t.id === id);
}

export function updateTodo(id: number, patch: Partial<Pick<Todo, 'title' | 'done'>>): Todo | undefined {
  const todo = todos.find((t) => t.id === id);
  if (todo) Object.assign(todo, patch);
  return todo;
}

export function deleteTodo(id: number): boolean {
  const i = todos.findIndex((t) => t.id === id);
  if (i < 0) return false;
  todos.splice(i, 1);
  return true;
}
`,
  'src/api/routes.ts': `import { Router } from 'express';
import { createTodo, deleteTodo, listTodos, updateTodo } from './todos';

export const router = Router();

router.get('/todos', (_req, res) => {
  res.json(listTodos());
});

router.post('/todos', (req, res) => {
  const title = String(req.body?.title ?? '').trim();
  if (!title) return res.status(400).json({ error: 'title is required' });
  res.status(201).json(createTodo(title));
});

router.patch('/todos/:id', (req, res) => {
  const todo = updateTodo(Number(req.params.id), req.body ?? {});
  if (!todo) return res.status(404).json({ error: 'not found' });
  res.json(todo);
});

router.delete('/todos/:id', (req, res) => {
  res.status(deleteTodo(Number(req.params.id)) ? 204 : 404).end();
});
`,
  'src/App.tsx': `import { useEffect, useState } from 'react';
import { TodoList } from './components/TodoList';
import type { Todo } from './api/todos';

export function App() {
  const [todos, setTodos] = useState<Todo[]>([]);

  useEffect(() => {
    fetch('/api/todos').then((r) => r.json()).then(setTodos);
  }, []);

  const done = todos.filter((t) => t.done).length;
  return (
    <main className="app">
      <h1>Today</h1>
      <p className="muted">{done} of {todos.length} done</p>
      <TodoList todos={todos} onChange={setTodos} />
    </main>
  );
}
`,
  'src/components/TodoList.tsx': `import type { Todo } from '../api/todos';
import { TodoItem } from './TodoItem';

export function TodoList({ todos, onChange }: { todos: Todo[]; onChange: (t: Todo[]) => void }) {
  const toggle = (id: number) => onChange(todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  return (
    <ul className="todos">
      {todos.map((t) => (
        <TodoItem key={t.id} todo={t} onToggle={() => toggle(t.id)} />
      ))}
    </ul>
  );
}
`,
  'src/components/TodoItem.tsx': `import type { Todo } from '../api/todos';

export function TodoItem({ todo, onToggle }: { todo: Todo; onToggle: () => void }) {
  return (
    <li className={todo.done ? 'todo done' : 'todo'}>
      <input type="checkbox" checked={todo.done} onChange={onToggle} />
      <span>{todo.title}</span>
    </li>
  );
}
`,
  'test/todos.test.ts': `import { describe, expect, it } from 'vitest';
import { createTodo, deleteTodo, listTodos, updateTodo } from '../src/api/todos';

describe('todos', () => {
  it('creates a todo with a trimmed title', () => {
    expect(createTodo('  Ship the /health endpoint ').title).toBe('Ship the /health endpoint');
  });

  it('lists open todos first', () => {
    const a = createTodo('a');
    updateTodo(a.id, { done: true });
    createTodo('b');
    expect(listTodos()[0].done).toBe(false);
  });

  it('deletes a todo', () => {
    const t = createTodo('temp');
    expect(deleteTodo(t.id)).toBe(true);
    expect(deleteTodo(t.id)).toBe(false);
  });
});
`,
};

/** Files that only exist after the "work in progress" (untracked in git). */
const NEW_FILES = {
  'src/rateLimit.ts': `import type { NextFunction, Request, Response } from 'express';

export interface RateLimitOptions {
  /** Length of one window in milliseconds. */
  windowMs: number;
  /** Requests allowed per client and window. */
  max: number;
}

/** A small fixed-window rate limiter, keyed by client IP. */
export function rateLimit({ windowMs, max }: RateLimitOptions) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  };
}
`,
  'test/rateLimit.test.ts': `import { describe, expect, it, vi } from 'vitest';
import { rateLimit } from '../src/rateLimit';

const call = (mw: ReturnType<typeof rateLimit>, ip = '10.0.0.24') => {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
  const next = vi.fn();
  mw({ ip } as never, res as never, next);
  return { res, next };
};

describe('rateLimit', () => {
  it('lets requests through up to the limit', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 2 });
    expect(call(mw).next).toHaveBeenCalled();
    expect(call(mw).next).toHaveBeenCalled();
  });

  it('answers 429 with Retry-After above the limit', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 1 });
    call(mw);
    const { res, next } = call(mw);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('counts each client separately', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 1 });
    call(mw, '10.0.0.1');
    expect(call(mw, '10.0.0.2').next).toHaveBeenCalled();
  });
});
`,
};

/** Type stubs in node_modules (gitignored), so the TypeScript server resolves the imports. */
const STUBS = {
  'node_modules/express/package.json': '{ "name": "express", "version": "4.21.1", "types": "index.d.ts" }\n',
  'node_modules/express/index.d.ts': `declare namespace e {
  interface Request { ip?: string; body?: any; params: Record<string, string>; headers: Record<string, string | undefined> }
  interface Response { status(code: number): Response; json(body: unknown): Response; end(): Response; setHeader(name: string, value: string): Response }
  type NextFunction = (err?: unknown) => void;
  type Handler = (req: Request, res: Response, next: NextFunction) => unknown;
  type ErrorHandler = (err: Error, req: Request, res: Response, next: NextFunction) => unknown;
  interface Router { get(p: string, ...h: Handler[]): Router; post(p: string, ...h: Handler[]): Router; patch(p: string, ...h: Handler[]): Router; delete(p: string, ...h: Handler[]): Router; use(...h: unknown[]): Router }
  interface Express extends Router { (req: unknown, res: unknown): void; use(...h: unknown[]): Express }
  function Router(): Router;
  function json(): Handler;
}
declare function e(): e.Express;
export = e;
`,
  'node_modules/vitest/package.json': '{ "name": "vitest", "version": "2.1.4", "types": "index.d.ts" }\n',
  'node_modules/vitest/index.d.ts': `export declare function describe(name: string, fn: () => void): void;
export declare function it(name: string, fn: () => void | Promise<void>): void;
export declare function expect(v: unknown): any;
export declare const vi: { fn(): any };
`,
  'node_modules/@types/react/package.json': '{ "name": "@types/react", "version": "18.3.12", "types": "index.d.ts" }\n',
  'node_modules/@types/react/index.d.ts': `export function useState<T>(initial: T): [T, (next: T) => void];
export function useEffect(effect: () => void | (() => void), deps?: unknown[]): void;
declare global {
  namespace JSX {
    type Element = any;
    interface IntrinsicElements { [name: string]: any }
    interface IntrinsicAttributes { key?: string | number }
  }
}
`,
  'node_modules/@types/react/jsx-runtime.d.ts': 'export declare const jsx: any;\nexport declare const jsxs: any;\nexport declare const Fragment: any;\n',
  'node_modules/@types/node/package.json': '{ "name": "@types/node", "version": "22.9.0", "types": "index.d.ts" }\n',
  'node_modules/@types/node/index.d.ts': `declare var process: { env: Record<string, string | undefined>; uptime(): number };
declare module 'node:http' {
  export function createServer(handler: unknown): { listen(port: number, cb?: () => void): void };
}
`,
};

const write = (root, rel, text) => {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

/** Write the sample project into `dir` (must be empty or missing) and build its git state. */
export function writeDemoWorkspace(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries({ ...FILES, ...STUBS })) write(dir, rel, text);
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_AUTHOR_DATE: '2026-11-20T09:30:00Z', GIT_COMMITTER_DATE: '2026-11-20T09:30:00Z' } });
  git('-c', 'core.autocrlf=false', 'init', '-q', '-b', 'main');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  git('config', 'core.autocrlf', 'false');
  // Shells started in the folder may drop PowerShell's module cache next to it: keep it out of git.
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '\nMicrosoft/\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Todo API with list / create / update / delete');

  // Work in progress: the rate limiter the agent session in the screenshots talks about.
  for (const [rel, text] of Object.entries(NEW_FILES)) write(dir, rel, text);
  const server = path.join(dir, 'src', 'server.ts');
  fs.writeFileSync(server, fs.readFileSync(server, 'utf8')
    .replace("import { logger } from './logger';", "import { logger } from './logger';\nimport { rateLimit } from './rateLimit';")
    .replace("app.use('/api', router);", "app.use('/api', rateLimit({ windowMs: 60_000, max: 120 }), router);"));
  const routes = path.join(dir, 'src', 'api', 'routes.ts');
  fs.writeFileSync(routes, fs.readFileSync(routes, 'utf8')
    .replace("import { createTodo, deleteTodo, listTodos, updateTodo } from './todos';", "import { createTodo, deleteTodo, findTodo, listTodos, updateTodo } from './todos';")
    .replace("router.patch('/todos/:id'", "router.get('/todos/:id', (req, res) => {\n  const todo = findTodo(req.params.id);\n  if (!todo) return res.status(404).json({ error: 'not found' });\n  res.json(todo);\n});\n\nrouter.patch('/todos/:id'"));
  git('add', 'src/api/routes.ts');
  return dir;
}
