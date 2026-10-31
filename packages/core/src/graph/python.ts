/**
 * Node, import and raw-reference extraction for Python (D12, D18, D19).
 *
 * Called from: `extract.ts`. Why it exists: graphify-compatible class/def nodes plus unresolved imports and refs.
 * Deliberately NOT done: lambdas, module-level assignments, docstring nodes, resolving imports (T2.2).
 */
import type { Node, Tree } from 'web-tree-sitter';
import { endLineOf, squashText, walkTree } from './build.ts';
import type { Out } from './build.ts';
import { limits } from './types.ts';

interface Frame {
  names: string[];
  parent: string;
  owner: string;
  /** The nearest enclosing def/class is a class: a `def` here is a method. */
  inClass: boolean;
  /** Inside a def body: a class here is not a node and its defs become plain functions of the def. */
  inDef?: boolean;
}

const TYPE_CHECKING_MAX_CLIMB = 64;

function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c !== null);
}

function fieldChildren(node: Node, field: string): Node[] {
  return node.childrenForFieldName(field).filter((c): c is Node => c !== null);
}

/** True when the node sits in the `if` branch of `if TYPE_CHECKING:` / `if typing.TYPE_CHECKING:`. */
function underTypeChecking(node: Node): boolean {
  let child: Node = node;
  let p = node.parent;
  for (let i = 0; p && i < TYPE_CHECKING_MAX_CLIMB; i++) {
    if (p.type === 'if_statement') {
      const cons = p.childForFieldName('consequence');
      const cond = p.childForFieldName('condition');
      if (cons && cond && cons.id === child.id && (cond.text === 'TYPE_CHECKING' || cond.text.endsWith('.TYPE_CHECKING'))) return true;
    }
    child = p;
    p = p.parent;
  }
  return false;
}

export function extractPython(tree: Tree, out: Out): void {
  const root: Frame = { names: [], parent: out.fileId, owner: out.fileId, inClass: false };
  const frames: Frame[] = [root];

  const onImport = (node: Node): void => {
    const typeOnly = underTypeChecking(node);
    const line = node.startPosition.row + 1;
    // judgment: `import a, b` is one statement with two modules; the entry shape has one specifier, so one entry per module.
    for (const n of fieldChildren(node, 'name')) {
      const target = n.type === 'aliased_import' ? n.childForFieldName('name') : n;
      const alias = n.type === 'aliased_import' ? n.childForFieldName('alias') : null;
      if (!target) continue;
      out.addImport({ specifier: target.text, names: [{ imported: '*', local: alias ? alias.text : target.text }], typeOnly, kind: 'import', line });
    }
  };

  const onFrom = (node: Node): void => {
    const mod = node.childForFieldName('module_name');
    if (!mod) return;
    const names: { imported: string; local: string }[] = [];
    for (const n of namedChildren(node)) {
      if (n.id === mod.id) continue;
      if (n.type === 'wildcard_import') names.push({ imported: '*', local: '*' });
    }
    for (const n of fieldChildren(node, 'name')) {
      const target = n.type === 'aliased_import' ? n.childForFieldName('name') : n;
      const alias = n.type === 'aliased_import' ? n.childForFieldName('alias') : null;
      if (target) names.push({ imported: target.text, local: alias ? alias.text : target.text });
    }
    out.addImport({ specifier: mod.text, names, typeOnly: underTypeChecking(node), kind: 'import', line: node.startPosition.row + 1 });
  };

  const attrParts = (fn: Node | null): { name: string; receiver: string | null } | null => {
    if (!fn) return null;
    if (fn.type === 'identifier') return { name: fn.text, receiver: null };
    if (fn.type === 'attribute') {
      const attr = fn.childForFieldName('attribute');
      const obj = fn.childForFieldName('object');
      if (attr && obj) return { name: attr.text, receiver: squashText(out.source.slice(obj.startIndex, obj.endIndex), limits.maxReceiverChars) };
    }
    return null;
  };

  walkTree(tree.rootNode, (node, depth) => {
    if (!node.isNamed) return false;
    const ctx = frames[depth - 1] ?? root;
    frames[depth] = ctx;
    switch (node.type) {
      case 'import_statement':
        onImport(node);
        return false;
      case 'import_from_statement':
        onFrom(node);
        return false;
      case 'class_definition': {
        const nm = node.childForFieldName('name');
        if (!nm) return true;
        // judgment: graphify emits no node for a class declared in a def body; it stays transparent so its defs hang on the def.
        if (ctx.inDef) {
          const bases = node.childForFieldName('superclasses');
          for (const b of bases ? namedChildren(bases) : []) {
            const p = attrParts(b);
            if (p) out.addRef({ from: ctx.owner, name: p.name, receiver: p.receiver, kind: 'extends', line: b.startPosition.row + 1 });
          }
          return true;
        }
        const names = [...ctx.names, nm.text];
        out.add({ names, type: 'class', label: nm.text, startLine: node.startPosition.row + 1, startCol: node.startPosition.column, endLine: endLineOf(node), parent: ctx.parent });
        const id = out.idOf(...names);
        frames[depth] = { names, parent: id, owner: id, inClass: true };
        const bases = node.childForFieldName('superclasses');
        for (const b of bases ? namedChildren(bases) : []) {
          const p = attrParts(b);
          if (p) out.addRef({ from: id, name: p.name, receiver: p.receiver, kind: 'extends', line: b.startPosition.row + 1 });
        }
        return true;
      }
      case 'function_definition': {
        const nm = node.childForFieldName('name');
        if (!nm) return true;
        const names = [...ctx.names, nm.text];
        const method = ctx.inClass;
        out.add({ names, type: method ? 'method' : 'function', label: method ? `.${nm.text}()` : `${nm.text}()`, startLine: node.startPosition.row + 1, startCol: node.startPosition.column, endLine: endLineOf(node), parent: ctx.parent });
        const id = out.idOf(...names);
        frames[depth] = { names, parent: id, owner: id, inClass: false, inDef: true };
        return true;
      }
      case 'call': {
        const p = attrParts(node.childForFieldName('function'));
        if (p) out.addRef({ from: ctx.owner, name: p.name, receiver: p.receiver, kind: 'call', line: node.startPosition.row + 1 });
        return true;
      }
      default:
        return true;
    }
  });
}
