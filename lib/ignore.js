/* Ignore rules for the file tools' searches: a built-in list of directories,
   files and extensions that never hold hand-written source, plus the project's
   own .gitignore files (git semantics: nested files, "!" negation, leading "/"
   anchoring, "**" globs). Zero dependencies. */

import fs from 'node:fs';
import path from 'node:path';

/* ------------------------------------------------------------------ */
/* Built-in skip rules                                                 */
/* ------------------------------------------------------------------ */

/** Version-control metadata: skipped even when the caller asks for ignored paths. */
export const VCS_DIRS = new Set(['.git', '.hg', '.svn', '.bzr', '.cvs']);

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
 * files of the tree being walked, and the caller's extra patterns.
 *
 *   const ignore = createIgnoreMatcher({ root, extra: config.searchIgnore });
 *   ignore.seed();                       // .gitignore files between repo root and `root`
 *   const mark = ignore.enter(dir);      // called when the walker enters a directory
 *   ignore.ignores(abs, isDir)           // skip this entry?
 *   ignore.leave(mark);                  // called when it leaves the directory
 */
export function createIgnoreMatcher({ root, extra = [], gitignore = true, builtins = true } = {}) {
  const base = path.resolve(root || '.');
  const stack = []; // [{ dir, patterns }] shallow → deep, in evaluation order
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

  function pushFile(dir, file) {
    const patterns = readIgnoreFile(file);
    if (patterns.length) stack.push({ dir, patterns });
  }

  return {
    /** Load the .gitignore chain from the repository root down to (and including) `root`. */
    seed() {
      if (!gitignore) return;
      const repo = findRepoRoot(base);
      if (!repo) return;
      pushFile(repo, path.join(repo, '.git', 'info', 'exclude')); // weakest: repo-wide excludes
      for (const dir of pathChain(repo, base)) pushFile(dir, path.join(dir, '.gitignore'));
    },
    /** Enter `dir` while walking; returns a mark for leave(). */
    enter(dir) {
      const mark = stack.length;
      if (gitignore && stack[stack.length - 1]?.dir !== path.resolve(dir)) {
        pushFile(dir, path.join(dir, '.gitignore')); // skipped when seed() already loaded it
      }
      return mark;
    },
    /** Leave the directory entered with `enter()`. */
    leave(mark) {
      stack.length = mark;
    },
    /** Should this path be skipped? `abs` is absolute, `isDir` its type. */
    ignores(abs, isDir) {
      const name = path.basename(abs);
      if (isDir) {
        if (VCS_DIRS.has(name)) return true;
        if (builtins && isSkippedDirName(name)) return true;
      } else {
        if (isSkippedFileName(name)) return true; // binaries are never greppable
        if (builtins && isNoiseFileName(name)) return true;
      }
      let ignored = false;
      for (const layer of stack) {
        const rel = relativeTo(layer.dir, abs);
        if (rel == null) continue;
        for (const p of layer.patterns) if (patternMatches(p, rel, isDir)) ignored = !p.negated;
      }
      const relBase = relativeTo(base, abs);
      if (relBase != null) {
        for (const p of extras) if (patternMatches(p, relBase, isDir)) ignored = !p.negated;
      }
      return ignored;
    },
  };
}
