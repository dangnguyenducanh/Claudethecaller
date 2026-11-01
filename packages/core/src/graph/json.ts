/**
 * Key-node extraction for config JSON files (D14).
 *
 * Called from: `extract.ts`. Why it exists: graphify yields key nodes for package.json-like files; the ids must match.
 * Deliberately NOT done: package nodes (`ref_*`, T2.2), keys inside arrays, any key below `limits.jsonMaxDepth`.
 */
import type { Node, Tree } from 'web-tree-sitter';
import type { Out } from './build.ts';
import { endLineOf } from './build.ts';
import { makeId } from './ids.ts';
import { limits } from './types.ts';

const CONFIG_NAMES = new Set([
  'package.json', 'tsconfig.json', 'jsconfig.json', 'composer.json', 'deno.json', 'deno.jsonc', 'bower.json', 'manifest.json', 'app.json',
  'now.json', 'vercel.json', 'angular.json', 'nest-cli.json', 'biome.json', 'biome.jsonc', 'renovate.json', '.babelrc', '.babelrc.json',
  '.eslintrc.json', '.prettierrc.json', '.prettierrc', 'babel.config.json',
]);
const CONFIG_SUFFIXES = ['.eslintrc.json', '.prettierrc.json', '.babelrc.json', 'tsconfig.json', 'jsconfig.json'];
const CONFIG_ROOT_KEYS = new Set([
  'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies', 'extends', '$schema', 'compilerOptions',
]);
const SCHEMA_MARKERS = ['$defs', 'definitions', '$id'];

function pairsOf(obj: Node): Node[] {
  return obj.namedChildren.filter((c): c is Node => c !== null && c.type === 'pair');
}

function keyText(pair: Node): string | null {
  const key = pair.childForFieldName('key');
  if (!key) return null;
  try {
    const v: unknown = JSON.parse(key.text);
    if (typeof v === 'string') return v;
  } catch {
    // fall through to the raw text
  }
  return key.text.replace(/^"|"$/g, '');
}

export function extractJson(tree: Tree, out: Out, path: string): void {
  const rootNode = tree.rootNode;
  if (rootNode.hasError) return;
  const value = rootNode.namedChildren.find((c): c is Node => c !== null && c.type !== 'comment');
  if (value?.type !== 'object') return;
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const rootPairs = pairsOf(value);
  const rootKeys = new Set(rootPairs.map((p) => keyText(p)));
  const byName = CONFIG_NAMES.has(base) || CONFIG_SUFFIXES.some((s) => base.endsWith(s));
  const byKeys = [...CONFIG_ROOT_KEYS].some((k) => rootKeys.has(k)) && !(rootKeys.has('$schema') && SCHEMA_MARKERS.some((k) => rootKeys.has(k)));
  if (!byName && !byKeys) return;

  interface Level {
    pairs: Node[];
    next: number;
    depth: number;
    parentId: string;
    parentKey: string;
  }
  const stack: Level[] = [{ pairs: rootPairs, next: 0, depth: 0, parentId: out.fileId, parentKey: '' }];
  let visited = 0;
  while (stack.length > 0) {
    const level = stack[stack.length - 1] as Level;
    const pair = level.pairs[level.next++];
    if (!pair) {
      stack.pop();
      continue;
    }
    if (visited >= limits.jsonMaxPairs) break;
    visited++;
    const key = keyText(pair);
    if (key === null) continue;
    const names = level.parentKey === '' ? [key] : [level.parentKey, key];
    let id = level.parentId;
    if (makeId(key) !== '') {
      id = out.idOf(...names);
      out.add({ names, type: 'key', label: key, startLine: pair.startPosition.row + 1, startCol: pair.startPosition.column, endLine: endLineOf(pair), parent: level.parentId });
    }
    const child = pair.childForFieldName('value');
    if (child?.type === 'object' && level.depth < limits.jsonMaxDepth) {
      stack.push({ pairs: pairsOf(child), next: 0, depth: level.depth + 1, parentId: id, parentKey: key });
    }
  }
}
