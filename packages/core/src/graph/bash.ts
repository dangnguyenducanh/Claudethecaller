/**
 * Node, `source` import and raw-command extraction for bash (D13, D18, D19).
 *
 * Called from: `extract.ts`. Why it exists: graphify-compatible script-entry and function nodes plus unresolved
 * commands. Deliberately NOT done: variables, aliases, deciding which commands are functions (T2.2 keeps only those
 * that resolve), expanding `$VAR` in `source` paths.
 */
import type { Node, Tree } from 'web-tree-sitter';
import { endLineOf, walkTree } from './build.ts';
import type { Out } from './build.ts';
import { makeId } from './ids.ts';

function sourceSpecifier(arg: Node | undefined): string | null {
  if (!arg) return null;
  const text = arg.text;
  if (text.includes('$') || text.includes('`')) return null;
  if (arg.type === 'word') return text;
  if (arg.type === 'string' || arg.type === 'raw_string') return text.slice(1, -1);
  return null;
}

export function extractBash(tree: Tree, out: Out, path: string): void {
  const entryId = `code:${makeId(path)}__entry`;
  const baseName = path.slice(path.lastIndexOf('/') + 1);
  out.addWithId(entryId, { type: 'function', label: `${baseName} script`, startLine: 1, startCol: 0, endLine: out.totalLines, parent: out.fileId });
  const owners: string[] = [entryId];

  walkTree(tree.rootNode, (node, depth) => {
    if (!node.isNamed) return false;
    owners[depth] = owners[depth - 1] ?? entryId;
    if (node.type === 'function_definition') {
      const nm = node.childForFieldName('name');
      if (!nm) return true;
      // judgment: bash functions are global, so the id has no enclosing names even for a function defined inside another.
      const names = [nm.text];
      out.add({ names, type: 'function', label: `${nm.text}()`, startLine: node.startPosition.row + 1, startCol: node.startPosition.column, endLine: endLineOf(node), parent: out.fileId });
      owners[depth] = out.idOf(...names);
      return true;
    }
    if (node.type === 'command') {
      const nm = node.childForFieldName('name');
      const word = nm && nm.childCount === 1 ? nm.child(0) : null;
      if (!nm || !word || word.type !== 'word' || word.text.startsWith('$')) return true;
      const line = node.startPosition.row + 1;
      out.addRef({ from: owners[depth] ?? entryId, name: word.text, receiver: null, kind: 'call', line });
      if (word.text === 'source' || word.text === '.') {
        const args = node.childrenForFieldName('argument');
        const spec = sourceSpecifier(args[0] ?? undefined);
        if (spec !== null) out.addImport({ specifier: spec, names: [], typeOnly: false, kind: 'source', line });
      }
    }
    return true;
  });
}
