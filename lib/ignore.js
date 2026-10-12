/* Ignore rules for the file tools' searches: a built-in list of directories,
   files and extensions that never hold hand-written source, plus the project's
   own .gitignore files (git semantics: nested files, "!" negation, leading "/"
   anchoring, "**" globs). Zero dependencies.

   .llmignore uses the same syntax but answers a different question. .gitignore
   says "this is not source"; .llmignore says "never send this to a model" —
   secrets, customer fixtures, licensed data. So it is a hard boundary: it
   applies to reading as well as searching, and include_ignored does not lift
   it, the same way .git is never searched. */

import fs from 'node:fs';
import path from 'node:path';

/* ------------------------------------------------------------------ */
/* Built-in skip rules                                                 */
/* ------------------------------------------------------------------ */

/** Version-control metadata: skipped even when the caller asks for ignored paths. */
export const VCS_DIRS = new Set(['.git', '.hg', '.svn', '.bzr', '.cvs']);

/** Project file listing paths that must never reach the model. Same syntax as .gitignore. */
export const LLM_IGNORE_FILE = '.llmignore';

/** Dependency, build, cache and tool-output directories — pruned by name, at any depth. */
export const SKIP_DIRS = new Set([
  // dependencies and package-manager caches
  'node_modules', 'bower_components', 'jspm_packages', 'web_modules', '.yarn', '.pnpm-store', '.npm', '.bun',
  // Python
  '.venv', 'venv', '.virtualenv', '.tox', '.nox', '__pycache__', '__pypackages__', '.eggs', '.mypy_cache',
  '.pytest_cache', '.ruff_cache', '.hypothesis', '.ipynb_checkpoints', 'htmlcov',
  // JS/TS build output and dev-server caches
  'dist', 'build', 'out', 'coverage', '.nyc_output', '.cache', '.turbo', '.parcel-cache', '.next', '.nuxt',
  '.output', '.svelte-kit', '.vite', '.angular', '.docusaurus', '.expo',
  // deployment / infrastructure state
  '.vercel', '.netlify', '.firebase', '.amplify', '.serverless', '.wrangler', '.terraform', '.terragrunt-cache', '.aws-sam',
  // other toolchains
  'target', '_build', '_opam', '.dart_tool', 'Pods', 'DerivedData', 'zig-cache', 'zig-out', '.stack-work',
  'dist-newstyle', '.gradle', '.cxx', '.kotlin', '.idea', 'CMakeFiles',
]);

/** Directory names with a build stamp in them (cmake-build-debug, pkg.egg-info, bazel-bin …). */
const SKIP_DIR_RE = /^(?:cmake-build-.+|bazel-.+|.+\.egg-info|.+\.dist-info|.+\.egg-link)$/i;

/** Extensions that hold binary data — grepping them is never useful. */
const BINARY_EXTS = [
  // images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'icns', 'tif', 'tiff', 'psd', 'xcf', 'heic', 'heif', 'apng',
  // media
  'mp3', 'mp4', 'm4a', 'm4v', 'wav', 'flac', 'ogg', 'oga', 'opus', 'aac', 'wma', 'avi', 'mov', 'mkv', 'webm', 'mpeg', 'mpg', 'm3u8',
  // documents, archives
  'pdf', 'eps', 'zip', 'tar', 'tgz', 'gz', 'bz2', 'xz', 'zst', 'lz4', '7z', 'rar', 'cab', 'iso', 'dmg', 'vhd', 'vmdk',
  // compiled artefacts
  'jar', 'war', 'ear', 'class', 'dex', 'apk', 'aab', 'ipa', 'nupkg', 'snap', 'exe', 'dll', 'so', 'dylib', 'o', 'obj',
  'a', 'lib', 'pdb', 'bin', 'elf', 'wasm', 'dat', 'pack', 'idx', 'rlib', 'rmeta', 'beam', 'pyc', 'pyo', 'pyd',
  'db', 'db3', 'sqlite', 'sqlite3', 'mdb', 'accdb', 'realm', 'ldb',
  // fonts
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'ttc',
];
const BINARY_EXT_RE = new RegExp(`\\.(?:${BINARY_EXTS.join('|')})$`, 'i');

/** Generated or machine-written files: pure noise for a content search. */
const NOISE_FILE_RE = /(?:\.min\.(?:js|css)|\.(?:map|log|lockb))$/i;

/** Files that are tool state rather than source. */
const SKIP_FILE_NAMES = new Set([
  '.DS_Store', 'Thumbs.db', 'ehthumbs.db', 'desktop.ini', '.git', '.eslintcache', '.stylelintcache',
]);

export function isSkippedDirName(name) {
  return SKIP_DIRS.has(name) || SKIP_DIR_RE.test(name);
}

/** True for files that are never worth reading (binaries, media, archives). */
export function isSkippedFileName(name) {
  return SKIP_FILE_NAMES.has(name) || BINARY_EXT_RE.test(name);
}

/** True for generated/minified files — skipped by default, reachable via include_ignored. */
export function isNoiseFileName(name) {
  return NOISE_FILE_RE.test(name);
}

/* ------------------------------------------------------------------ */
/* Glob → RegExp                                                       */
/* ------------------------------------------------------------------ */

/**
 * Compile a gitignore-style glob (no leading "/", no trailing "/") to a RegExp
 * that full-matches a "/"-separated relative path.
 *   `*`      any run of characters except "/"
 *   `**`     any run of characters, "/" included ("**\/*" also matches nothing)
 *   `?`      one character except "/"
 *   `[a-z]`  character class, passed through
 */
export function globToRegExp(glob) {
  const g = String(glob ?? '');
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          out += '(?:[^/]+/)*'; // "**/" = any number of leading directories
        } else {
          out += '.*'; // trailing or embedded "**"
        }
        continue;
      }
      out += '[^/]*';
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      continue;
    }
    if (c === '[') {
      const end = g.indexOf(']', i + 1);
      if (end > i + 1) {
        let cls = g.slice(i, end + 1);
        if (cls[1] === '!') cls = `[^${cls.slice(2)}`; // glob's negated class is "^" in a regexp
        out += cls.replace(/\\/g, '\\\\');
        i = end;
        continue;
      }
      out += '\\[';
      continue;
    }
    out += c.replace(/[.+^${}()|[\]\\/]/, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/* ------------------------------------------------------------------ */
/* .gitignore parsing                                                  */
/* ------------------------------------------------------------------ */

/**
 * Parse .gitignore (or .git/info/exclude) text into patterns:
 * `{ negated, dirOnly, anchored, re }`.
 */
export function parseGitignore(text) {
  const patterns = [];
  for (let line of String(text ?? '').split(/\r?\n/)) {
    line = line.replace(/(?<!\\)[ \t]+$/, ''); // trailing blanks are not part of the pattern
    if (!line || line.startsWith('#')) continue;
    let negated = false;
    let body = line;
    if (body.startsWith('!')) {
      negated = true;
      body = body.slice(1);
    } else if (body.startsWith('\\!') || body.startsWith('\\#')) {
      body = body.slice(1); // escaped "!" / "#" are literal
    }
    const dirOnly = body.endsWith('/');
    let glob = body.replace(/\/+$/, '');
    const anchored = glob.includes('/');
    if (glob.startsWith('/')) glob = glob.slice(1); // leading "/" marks the anchor, it is not part of the path
    if (!glob) continue;
    patterns.push({ negated, dirOnly, anchored, re: globToRegExp(glob) });
  }
  return patterns;
}

/** Pattern matches `rel` (a "/"-relative path)? Unanchored patterns match at any depth. */
function patternMatches(pattern, rel, isDir) {
  if (pattern.dirOnly && !isDir) return false;
  if (pattern.anchored) return pattern.re.test(rel);
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    if (pattern.re.test(parts.slice(i).join('/'))) return true;
  }
  return false;
}

/** Read and parse an ignore file; [] when it does not exist or cannot be read. */
export function readIgnoreFile(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 1024 * 1024) return [];
    return parseGitignore(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

/** Nearest directory at or above `dir` that holds a `.git` entry (repo root), or null. */
export function findRepoRoot(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/* ------------------------------------------------------------------ */
/* Matcher                                                             */
/* ------------------------------------------------------------------ */

/** "/"-separated path of `abs` relative to `dir`; null when it is not inside. */
function relativeTo(dir, abs) {
  const r = path.relative(dir, abs);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
  return r.split(path.sep).join('/');
}

/** All directories from `from` down to `to` (both ancestors of one another). */
function pathChain(from, to) {
  const chain = [];
  let cur = path.resolve(to);
  for (;;) {
    chain.push(cur);
    if (cur === path.resolve(from)) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return chain.reverse();
}

/**
 * Ignore rules for a search: built-in skip lists (optional), the .gitignore
 * files of the tree being walked, the .llmignore files (always), and the
 * caller's extra patterns.
 *
 *   const ignore = createIgnoreMatcher({ root, extra: config.searchIgnore });
 *   ignore.seed();                       // ignore files between repo root and `root`
 *   const mark = ignore.enter(dir);      // called when the walker enters a directory
 *   ignore.ignores(abs, isDir)           // skip this entry?
 *   ignore.blocked(abs, isDir)           // .llmignore only — skipped for any reason?
 *   ignore.leave(mark);                  // called when it leaves the directory
 *
 * `gitignore: false` (the model passed include_ignored) switches off the
 * .gitignore layers and the built-in skip lists. It does not switch off
 * .llmignore: that file exists to keep content away from the model.
 */
export function createIgnoreMatcher({ root, extra = [], gitignore = true, builtins = true } = {}) {
  const base = path.resolve(root || '.');
  const soft = []; // .gitignore layers, shallow → deep, in evaluation order
  const hard = []; // .llmignore layers — a boundary, not a preference
  const extras = (extra || [])
    .map((raw) => {
      const line = String(raw ?? '').trim();
      if (!line) return null;
      const negated = line.startsWith('!');
      const spec = negated ? line.slice(1) : line;
      let glob = spec.replace(/\/+$/, '');
      if (!glob) return null;
      const anchored = glob.includes('/');
      if (glob.startsWith('/')) glob = glob.slice(1);
      return { negated, dirOnly: spec.endsWith('/'), anchored, re: globToRegExp(glob) };
    })
    .filter(Boolean);

  function pushFile(stack, dir, file) {
    const patterns = readIgnoreFile(file);
    if (patterns.length) stack.push({ dir: path.resolve(dir), patterns });
  }

  /** Load both ignore files of one directory, unless they are already on top. */
  function pushDir(dir) {
    const resolved = path.resolve(dir);
    if (gitignore && soft[soft.length - 1]?.dir !== resolved) {
      pushFile(soft, resolved, path.join(resolved, '.gitignore'));
    }
    if (hard[hard.length - 1]?.dir !== resolved) {
      pushFile(hard, resolved, path.join(resolved, LLM_IGNORE_FILE));
    }
  }

  /** Last pattern wins, the way git resolves a chain of ignore files. */
  function verdict(layers, abs, isDir) {
    let ignored = false;
    for (const layer of layers) {
      const rel = relativeTo(layer.dir, abs);
      if (rel == null) continue;
      for (const p of layer.patterns) if (patternMatches(p, rel, isDir)) ignored = !p.negated;
    }
    return ignored;
  }

  return {
    /** Load the ignore-file chain from the repository root down to (and including) `root`. */
    seed() {
      const repo = findRepoRoot(base);
      if (gitignore && repo) pushFile(soft, repo, path.join(repo, '.git', 'info', 'exclude')); // weakest
      for (const dir of pathChain(repo || base, base)) pushDir(dir);
    },
    /** Enter `dir` while walking; returns an opaque mark for leave(). */
    enter(dir) {
      const mark = { soft: soft.length, hard: hard.length };
      pushDir(dir); // a no-op when seed() already loaded this directory
      return mark;
    },
    /** Leave the directory entered with `enter()`. */
    leave(mark) {
      soft.length = mark?.soft ?? soft.length;
      hard.length = mark?.hard ?? hard.length;
    },
    /** Does .llmignore forbid sending this path's content to the model? */
    blocked(abs, isDir) {
      return verdict(hard, abs, isDir);
    },
    /** Should this path be skipped? `abs` is absolute, `isDir` its type. */
    ignores(abs, isDir) {
      if (verdict(hard, abs, isDir)) return true; // not negotiable, include_ignored or not
      const name = path.basename(abs);
      if (isDir) {
        if (VCS_DIRS.has(name)) return true;
        if (builtins && isSkippedDirName(name)) return true;
      } else {
        if (isSkippedFileName(name)) return true; // binaries are never greppable
        if (builtins && isNoiseFileName(name)) return true;
      }
      let ignored = verdict(soft, abs, isDir);
      const relBase = relativeTo(base, abs);
      if (relBase != null) {
        for (const p of extras) if (patternMatches(p, relBase, isDir)) ignored = !p.negated;
      }
      return ignored;
    },
  };
}

/* ------------------------------------------------------------------ */
/* .llmignore for single paths (read_file)                             */
/* ------------------------------------------------------------------ */

/**
 * Check one path against the .llmignore files above it, without walking a
 * tree. read_file uses this: a search that quietly skips a secret is no use
 * if the model can read it by name.
 *
 * The chain runs from the repository root (or `root`, whichever is higher)
 * down to the file's own directory, so a nested .llmignore can both add
 * patterns and negate an inherited one. Parsed files are cached by mtime, so
 * the common case costs one statSync per directory and edits still apply
 * immediately.
 */
export function createLlmIgnoreGuard({ root } = {}) {
  const base = path.resolve(root || '.');
  const cache = new Map(); // file -> { mtimeMs, size, patterns }

  const load = (file) => {
    let st = null;
    try {
      st = fs.statSync(file);
    } catch {
      cache.delete(file);
      return [];
    }
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.patterns;
    const patterns = readIgnoreFile(file);
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, patterns });
    return patterns;
  };

  return {
    /**
     * Is `target` (absolute) covered by an .llmignore rule?
     * Returns the directory whose .llmignore decided it, or null when it is allowed.
     */
    blockedBy(target, isDir = false) {
      const abs = path.resolve(target);
      const top = findRepoRoot(abs) || findRepoRoot(base) || base;
      // Only directories that are ancestors of the target can have a say.
      const dir = isDir ? abs : path.dirname(abs);
      if (relativeTo(top, dir) == null && path.resolve(top) !== dir) return null;
      let decidedBy = null;
      for (const layer of pathChain(top, dir)) {
        const rel = relativeTo(layer, abs);
        if (rel == null) continue;
        for (const p of load(path.join(layer, LLM_IGNORE_FILE))) {
          if (patternMatches(p, rel, isDir)) decidedBy = p.negated ? null : layer;
        }
      }
      return decidedBy;
    },
  };
}
