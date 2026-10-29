import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { App, InstallState, PackageManager, Project } from './types.ts';

const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', '.turbo', '.cache']);
export const PMS: readonly PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun', 'composer'];

interface PackageJson { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; version?: string }
interface ComposerJson { scripts?: Record<string, string | string[]>; require?: Record<string, string>; 'require-dev'?: Record<string, string>; version?: string }

const subdirs = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !IGNORE.has(d.name) && !d.name.startsWith('.'))
      .map((d) => path.join(dir, d.name));
  } catch { return []; }
};

const readJson = <T>(file: string): T | null => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; } };
const readPkg = (dir: string) => readJson<PackageJson>(path.join(dir, 'package.json'));
export const readScripts = (dir: string, pm: PackageManager = 'npm'): string[] | null => {
  const p = readJson<PackageJson | ComposerJson>(path.join(dir, pm === 'composer' ? 'composer.json' : 'package.json'));
  return p && Object.keys(p.scripts || {});
};
export const runCmd = (pm: PackageManager, script: string): string[] => pm === 'composer' ? ['composer', 'run-script', script] : [pm, 'run', script];

const has = (dir: string, ...files: string[]) => files.some((f) => fs.existsSync(path.join(dir, f)));

// PHP projects (htdocs style): composer.json, Laravel's artisan, WordPress, or a plain index.php.
function phpApp(dir: string): App | null {
  if (!has(dir, 'composer.json', 'index.php', 'artisan', 'wp-config.php', 'public/index.php')) return null;
  const composer = readJson<ComposerJson>(path.join(dir, 'composer.json'));
  const req = { ...composer?.require, ...composer?.['require-dev'] };
  const scripts = Object.keys(composer?.scripts || {});
  const stack = ['php',
    has(dir, 'artisan') && 'laravel', has(dir, 'wp-config.php', 'wp-content') && 'wordpress',
    'symfony/framework-bundle' in req && 'symfony', 'codeigniter4/framework' in req && 'codeigniter',
  ].filter((s): s is string => !!s);
  return {
    id: `${dir}#php`, name: 'php', kind: 'php', path: dir, pm: 'composer', scripts,
    cmds: Object.fromEntries(scripts.map((s) => [s, ([] as string[]).concat(composer?.scripts?.[s] ?? []).join(' && ')])),
    stack, version: composer?.version || null, autostart: null,
  };
}

// .env files are listed (and editable) per project; DB name links straight into phpMyAdmin.
const ENV_RE = /^\.env(\.[\w.-]+)?$/;
const envFiles = (dirs: string[]) => [...new Set(dirs)].flatMap((d) => {
  try { return fs.readdirSync(d).filter((f) => ENV_RE.test(f)).map((f) => path.join(d, f)); } catch { return []; }
});
export function dbName(files: string[]): string | null {
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (f.endsWith('wp-config.php')) {
      const m = text.match(/define\(\s*['"]DB_NAME['"]\s*,\s*['"]([^'"]+)['"]/);
      if (m) return m[1];
      continue;
    }
    const v = (k: string) => text.match(new RegExp(`^\\s*${k}\\s*=\\s*["']?([^"'\\r\\n#]+)`, 'm'))?.[1]?.trim();
    const name = v('DB_DATABASE') || v('DB_NAME') || v('MYSQL_DATABASE') || v('DATABASE_URL')?.match(/^(?:mysql|mariadb)[^:]*:\/\/[^/]+\/([^?\s]+)/)?.[1];
    if (name) return name;
  }
  return null;
}

// Shown as tags in the overview; order = display priority.
const STACK = ['next', 'nuxt', '@sveltejs/kit', 'astro', 'vite', 'react', 'vue', 'svelte', '@angular/core', 'express', 'fastify', 'hono', '@nestjs/core', 'koa', 'electron', 'prisma', 'drizzle-orm', 'mongoose', 'typescript', 'tailwindcss', 'vitest', 'jest', 'playwright'];
const LABEL: Record<string, string> = { '@sveltejs/kit': 'sveltekit', '@angular/core': 'angular', '@nestjs/core': 'nestjs', 'drizzle-orm': 'drizzle' };

function gitBranch(dir: string): string | null {
  try {
    const head = fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim();
    return head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 7);
  } catch { return null; }
}

function detectPm(...dirs: string[]): PackageManager {
  for (const d of dirs) {
    if (fs.existsSync(path.join(d, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(d, 'yarn.lock'))) return 'yarn';
    if (fs.existsSync(path.join(d, 'bun.lockb')) || fs.existsSync(path.join(d, 'bun.lock'))) return 'bun';
    if (fs.existsSync(path.join(d, 'package-lock.json'))) return 'npm';
  }
  return 'npm';
}

// Where frameworks keep app icons; first hit wins, so vector/large formats come first.
const ICONS = [
  'app/icon.svg', 'src/app/icon.svg', 'public/favicon.svg', 'public/icon.svg', 'public/logo.svg', 'static/favicon.svg',
  'app/icon.png', 'src/app/icon.png', 'app/apple-icon.png', 'public/apple-touch-icon.png', 'public/icon.png', 'public/logo.png',
  'public/logo192.png', 'public/favicon.png', 'static/favicon.png', 'build/icon.png', 'resources/icon.png', 'assets/icon.png', 'src/assets/logo.svg', 'src/assets/logo.png',
  'app/favicon.ico', 'src/app/favicon.ico', 'public/favicon.ico', 'static/favicon.ico', 'favicon.ico', 'icon.png', 'logo.svg', 'logo.png',
];
const findIcon = (dirs: string[]): string | null => {
  for (const rel of ICONS) for (const d of dirs) {
    const f = path.join(d, rel);
    if (fs.existsSync(f)) return f;
  }
  return null;
};

// node_modules missing, or a dependency from package.json not installed (e.g. after a pull added one).
// Checks content, not timestamps: git checkouts and script edits touch mtimes without changing what's needed.
export function installState(dir: string, pkg: PackageJson | null = readPkg(dir)): InstallState {
  if (!fs.existsSync(path.join(dir, 'node_modules'))) return 'missing';
  const deps = Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies });
  return deps.every((d) => fs.existsSync(path.join(dir, 'node_modules', d, 'package.json'))) ? 'ok' : 'stale';
}

// Project = folder; apps = every package.json at depth 0..2 (root, backend/, packages/api/ ...)
export function scanProject(dir: string): Project {
  const candidates = [dir, ...subdirs(dir).flatMap((d) => [d, ...subdirs(d)])];
  const apps: App[] = [];
  for (const appDir of candidates) {
    const pkg = readPkg(appDir);
    if (!pkg) continue;
    const scripts = Object.keys(pkg.scripts || {});
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    apps.push({
      id: appDir,
      name: path.relative(dir, appDir).replaceAll('\\', '/') || path.basename(dir),
      path: appDir,
      pm: detectPm(appDir, dir),
      scripts,
      cmds: pkg.scripts || {},
      stack: STACK.filter((d) => d in deps).map((d) => LABEL[d] || d),
      version: pkg.version || null,
      install: installState(appDir, pkg),
      autostart: ['dev', 'start', 'serve'].find((s) => scripts.includes(s)) || null,
    });
  }
  const php = phpApp(dir);
  if (php) apps.push(php);
  const envs = envFiles([dir, ...apps.map((a) => a.path)]);
  return {
    id: dir, name: path.basename(dir), path: dir, branch: gitBranch(dir),
    icon: findIcon([dir, ...apps.map((a) => a.path)]), envFiles: envs,
    db: dbName([...envs.filter((f) => !/example|sample|template/i.test(f)), path.join(dir, 'wp-config.php')]),
    apps,
  };
}

export function scanAll({ roots = [], manual = [] }: { roots?: string[]; manual?: string[] }): Project[] {
  const dirs = [...roots.flatMap(subdirs), ...manual];
  return dirs.map(scanProject).filter((p) => p.apps.length);
}

// Fresh scan wins for structure, old config wins for user choices (name, hidden, autostart, links).
export function merge(oldProjects: Project[] = [], fresh: Project[]): Project[] {
  const old = new Map(oldProjects.map((p) => [p.id, p]));
  return fresh.map((p) => {
    const o = old.get(p.id);
    if (!o) return p;
    const oldApps = new Map(o.apps.map((a) => [a.id, a]));
    return {
      ...p, name: o.name, hidden: o.hidden, services: o.services, bootStart: o.bootStart,
      apps: p.apps.map((a) => {
        const oa = oldApps.get(a.id);
        return oa && (oa.autostart === null || a.scripts.includes(oa.autostart)) ? { ...a, autostart: oa.autostart } : a;
      }),
    };
  });
}

if (process.argv[1]?.endsWith('scan.ts') && process.argv.includes('--test')) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-scan-'));
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };
  const find = <T extends { name: string }>(list: T[], name: string): T => {
    const x = list.find((p) => p.name === name);
    assert.ok(x, `missing ${name}`);
    return x;
  };
  write('shop/backend/package.json', JSON.stringify({ scripts: { start: 'node .', dev: 'nodemon' }, dependencies: { express: '5', '@nestjs/core': '1' } }));
  write('shop/.git/HEAD', 'ref: refs/heads/feature/x\n');
  write('shop/frontend/package.json', JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' } }));
  write('shop/frontend/pnpm-lock.yaml', '');
  write('shop/frontend/public/favicon.ico', 'x');
  write('shop/frontend/src/app/icon.svg', '<svg/>');
  write('shop/frontend/node_modules/x/package.json', JSON.stringify({ scripts: { evil: 'x' } }));
  write('notes/readme.md', 'no package.json');
  write('mono/package.json', JSON.stringify({ scripts: { start: 'x' } }));
  write('mono/packages/api/package.json', '{broken json');

  const projects = scanAll({ roots: [root] });
  assert.deepEqual(projects.map((p) => p.name).sort(), ['mono', 'shop']);
  const shop = find(projects, 'shop');
  assert.deepEqual(shop.apps.map((a) => a.name).sort(), ['backend', 'frontend']);
  const fe = find(shop.apps, 'frontend');
  assert.equal(fe.pm, 'pnpm');
  assert.equal(fe.autostart, 'dev');
  const be = find(shop.apps, 'backend');
  assert.equal(be.pm, 'npm');
  assert.deepEqual(be.stack, ['express', 'nestjs']);
  assert.equal(be.cmds.dev, 'nodemon');
  assert.equal(shop.branch, 'feature/x');
  assert.equal(shop.icon, path.join(root, 'shop/frontend/src/app/icon.svg'));
  assert.equal(find(projects, 'mono').icon, null);

  // PHP + env + db detection
  write('blog/wp-config.php', "<?php define( 'DB_NAME', 'wp_blog' );");
  write('blog/index.php', '<?php');
  write('shop/backend/.env', 'PORT=1\nDATABASE_URL="mysql://root:@localhost:3306/shop_db?x=1"\n');
  write('shop/backend/.env.example', 'DB_DATABASE=nope');
  write('lara/artisan', '');
  write('lara/composer.json', JSON.stringify({ require: { 'laravel/framework': '11' }, scripts: { dev: ['php artisan serve'] } }));
  write('lara/.env', 'DB_DATABASE=lara_app');
  const again = scanAll({ roots: [root] });
  const blog = find(again, 'blog');
  assert.deepEqual(blog.apps.map((a) => a.kind), ['php']);
  assert.ok(blog.apps[0].stack.includes('wordpress'));
  assert.equal(blog.db, 'wp_blog');
  const shop2 = find(again, 'shop');
  assert.equal(shop2.db, 'shop_db');
  assert.equal(shop2.envFiles.length, 2);
  const lara = find(again, 'lara');
  assert.ok(lara.apps[0].stack.includes('laravel'));
  assert.equal(lara.apps[0].cmds.dev, 'php artisan serve');
  assert.equal(lara.db, 'lara_app');
  assert.deepEqual(readScripts(path.join(root, 'lara'), 'composer'), ['dev']);
  assert.deepEqual(runCmd('composer', 'dev'), ['composer', 'run-script', 'dev']);

  // install state
  assert.equal(be.install, 'missing');
  write('shop/backend/node_modules/express/package.json', '{}');
  assert.equal(installState(path.join(root, 'shop/backend')), 'stale', '@nestjs/core still missing');
  write('shop/backend/node_modules/@nestjs/core/package.json', '{}');
  assert.equal(installState(path.join(root, 'shop/backend')), 'ok');
  assert.deepEqual(find(projects, 'mono').apps.map((a) => a.name), ['mono']);

  const edited = projects.map((p) => p.name === 'shop' ? { ...p, name: 'Magazin', hidden: true, apps: p.apps.map((a) => ({ ...a, autostart: a.scripts.includes('build') ? 'build' : a.autostart })) } : p);
  const merged = merge(edited, scanAll({ roots: [root] }));
  const m = merged.find((p) => p.id === shop.id);
  assert.equal(m?.name, 'Magazin');
  assert.equal(m?.hidden, true);
  assert.equal(m?.apps.find((a) => a.name === 'frontend')?.autostart, 'build');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('scan.ts: all checks passed');
}
