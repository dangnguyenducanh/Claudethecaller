/**
 * Node, import and raw-reference extraction for ts, tsx and js (one rule set, D11, D18, D19).
 *
 * Called from: `extract.ts`. Why it exists: turns a tree-sitter tree into graphify-compatible nodes plus unresolved
 * imports and references. Deliberately NOT done: resolving anything (T2.2), `var` declarations, CommonJS exports,
 * docstring/comment nodes, nodes inside namespaces beyond what the generic walk finds.
 */
import type { Node, Tree } from 'web-tree-sitter';
import { endLineOf, squashText, walkTree } from './build.ts';
import type { Out } from './build.ts';
import { limits } from './types.ts';

interface Frame {
  /** Enclosing symbol names, outer to inner (the id parts after the file stem). */
  names: string[];
  /** Node id that owns children nodes (`contains` source). */
  parent: string;
  /** Innermost function/method/class node id (the `from` of raw refs). */
  owner: string;
  /** Inside a class expression: members are not nodes (judgment). */
  anonClass: boolean;
  /** Inside the initializer of a named variable node: functions and classes declared there are not nodes (D8). */
  inVar?: boolean;
}

const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
const VARIABLE_VALUES = new Set(['object', 'array', 'as_expression', 'satisfies_expression', 'call_expression', 'new_expression']);

function hasAnonChild(node: Node, type: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && !c.isNamed && c.type === type) return true;
  }
  return false;
}

function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c !== null);
}

function stringValue(n: Node | null): string | null {
  if (n?.type !== 'string') return null;
  const t = n.text;
  return t.length >= 2 ? t.slice(1, -1) : null;
}

function nameOf(n: Node): string {
  return n.type === 'string' ? n.text.slice(1, -1) : n.text;
}

/** Name and receiver of a callee or type reference; `null` for shapes D19 leaves out. */
function calleeParts(fn: Node | null, source: string): { name: string; receiver: string | null } | null {
  if (!fn) return null;
  if (fn.type === 'identifier' || fn.type === 'type_identifier') return { name: fn.text, receiver: null };
  if (fn.type === 'member_expression' || fn.type === 'nested_type_identifier') {
    const prop = fn.childForFieldName('property') ?? fn.childForFieldName('name');
    const obj = fn.childForFieldName('object') ?? fn.childForFieldName('module');
    if (!prop || !obj) return null;
    return { name: prop.text, receiver: squashText(source.slice(obj.startIndex, obj.endIndex), limits.maxReceiverChars) };
  }
  if (fn.type === 'generic_type') return calleeParts(fn.childForFieldName('name'), source);
  return null;
}

/** First row/column of a node ignoring leading decorators. */
function declStart(node: Node): { line: number; col: number } {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type !== 'decorator') return { line: c.startPosition.row + 1, col: c.startPosition.column };
  }
  return { line: node.startPosition.row + 1, col: node.startPosition.column };
}

export function extractTsJs(tree: Tree, out: Out): void {
  const root: Frame = { names: [], parent: out.fileId, owner: out.fileId, anonClass: false };
  const frames: Frame[] = [root];
  const types: string[] = [''];

  const heritageRefs = (node: Node, from: string): void => {
    for (const child of namedChildren(node)) {
      if (child.type === 'class_heritage') {
        for (const clause of namedChildren(child)) {
          if (clause.type === 'extends_clause') {
            for (const v of namedChildren(clause)) {
              const p = calleeParts(v, out.source);
              if (p) out.addRef({ from, name: p.name, receiver: p.receiver, kind: 'extends', line: v.startPosition.row + 1 });
            }
          } else if (clause.type === 'implements_clause') {
            for (const v of namedChildren(clause)) {
              const p = calleeParts(v, out.source);
              if (p) out.addRef({ from, name: p.name, receiver: p.receiver, kind: 'implements', line: v.startPosition.row + 1 });
            }
          } else {
            const p = calleeParts(clause, out.source);
            if (p) out.addRef({ from, name: p.name, receiver: p.receiver, kind: 'extends', line: clause.startPosition.row + 1 });
          }
        }
      } else if (child.type === 'extends_type_clause') {
        for (const v of namedChildren(child)) {
          const p = calleeParts(v, out.source);
          if (p) out.addRef({ from, name: p.name, receiver: p.receiver, kind: 'extends', line: v.startPosition.row + 1 });
        }
      }
    }
  };

  const importNames = (clause: Node): { names: { imported: string; local: string }[]; allType: boolean } => {
    const names: { imported: string; local: string }[] = [];
    let specs = 0;
    let typed = 0;
    let plain = false;
    for (const c of namedChildren(clause)) {
      if (c.type === 'identifier') {
        names.push({ imported: 'default', local: c.text });
        plain = true;
      } else if (c.type === 'namespace_import') {
        const id = namedChildren(c)[0];
        if (id) names.push({ imported: '*', local: id.text });
        plain = true;
      } else if (c.type === 'named_imports') {
        for (const s of namedChildren(c)) {
          if (s.type !== 'import_specifier') continue;
          const nm = s.childForFieldName('name');
          if (!nm) continue;
          const imported = nameOf(nm);
          const alias = s.childForFieldName('alias');
          names.push({ imported, local: alias ? alias.text : imported });
          specs++;
          if (hasAnonChild(s, 'type')) typed++;
        }
      }
    }
    return { names, allType: !plain && specs > 0 && typed === specs };
  };

  const onImport = (node: Node): void => {
    const line = node.startPosition.row + 1;
    const req = namedChildren(node).find((c) => c.type === 'import_require_clause');
    if (req) {
      const spec = stringValue(req.childForFieldName('source'));
      if (spec !== null) out.addImport({ specifier: spec, names: [], typeOnly: false, kind: 'require', line });
      return;
    }
    const spec = stringValue(node.childForFieldName('source'));
    if (spec === null) return;
    const clause = namedChildren(node).find((c) => c.type === 'import_clause');
    const info = clause ? importNames(clause) : { names: [], allType: false };
    out.addImport({ specifier: spec, names: info.names, typeOnly: hasAnonChild(node, 'type') || info.allType, kind: 'import', line });
  };

  const onReexport = (node: Node, spec: string): void => {
    const names: { imported: string; local: string }[] = [];
    let specs = 0;
    let typed = 0;
    let wildcard = true;
    for (const c of namedChildren(node)) {
      if (c.type === 'export_clause') {
        wildcard = false;
        for (const s of namedChildren(c)) {
          if (s.type !== 'export_specifier') continue;
          const nm = s.childForFieldName('name');
          if (!nm) continue;
          const imported = nameOf(nm);
          const alias = s.childForFieldName('alias');
          names.push({ imported, local: alias ? alias.text : imported });
          specs++;
          if (hasAnonChild(s, 'type')) typed++;
        }
      } else if (c.type === 'namespace_export') {
        wildcard = false;
        const id = namedChildren(c)[0];
        names.push({ imported: '*', local: id ? id.text : '*' });
      }
    }
    if (wildcard) names.push({ imported: '*', local: '*' });
    out.addImport({ specifier: spec, names, typeOnly: hasAnonChild(node, 'type') || (specs > 0 && typed === specs), kind: 'reexport', line: node.startPosition.row + 1 });
  };

  const onCall = (node: Node, ctx: Frame): void => {
    const fn = node.childForFieldName('function');
    if (fn?.type === 'import') {
      const first = node.childForFieldName('arguments')?.namedChild(0) ?? null;
      const spec = stringValue(first);
      if (spec !== null) out.addImport({ specifier: spec, names: [], typeOnly: false, kind: 'dynamic', line: node.startPosition.row + 1 });
      return;
    }
    // judgment: `require('x')` is both an import entry and an ordinary call ref (D19 says every call expression).
    if (fn?.type === 'identifier' && fn.text === 'require') {
      const spec = stringValue(node.childForFieldName('arguments')?.namedChild(0) ?? null);
      if (spec !== null) out.addImport({ specifier: spec, names: [], typeOnly: false, kind: 'require', line: node.startPosition.row + 1 });
    }
    const p = calleeParts(fn, out.source);
    if (p) out.addRef({ from: ctx.owner, name: p.name, receiver: p.receiver, kind: 'call', line: node.startPosition.row + 1 });
  };

  const addSymbol = (ctx: Frame, node: Node, name: string, type: 'function' | 'method' | 'class' | 'interface', startFromDecl = false): Frame | null => {
    const label = type === 'method' ? `.${name}()` : type === 'function' ? `${name}()` : name;
    const start = startFromDecl ? declStart(node) : { line: node.startPosition.row + 1, col: node.startPosition.column };
    const names = [...ctx.names, name];
    out.add({ names, type, label, startLine: start.line, startCol: start.col, endLine: endLineOf(node), parent: ctx.parent });
    const id = out.idOf(...names);
    return { names, parent: id, owner: type === 'interface' ? ctx.owner : id, anonClass: false };
  };

  const onDeclarator = (node: Node, depth: number, ctx: Frame): Frame | null => {
    const declDepth = depth - 1;
    if (types[declDepth] !== 'lexical_declaration') return null;
    const exported = types[declDepth - 1] === 'export_statement';
    const container = declDepth - (exported ? 2 : 1);
    // judgment: an exported declarator inside a namespace or `declare module` body is kept like a module-level one (graphify does); a non-exported one there is not.
    const inModuleBody = types[container] === 'statement_block' && (types[container - 1] === 'internal_module' || types[container - 1] === 'module');
    if (!(container === 1 || (exported && inModuleBody))) return null;
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return null;
    const value = node.childForFieldName('value');
    const line = node.startPosition.row + 1;
    const col = node.startPosition.column;
    const end = endLineOf(node);
    if (nameNode.type === 'object_pattern') {
      if (!exported) return null;
      for (const el of namedChildren(nameNode)) {
        let key: Node | null = null;
        if (el.type === 'shorthand_property_identifier_pattern') key = el;
        else if (el.type === 'pair_pattern') key = el.childForFieldName('key');
        else if (el.type === 'object_assignment_pattern') key = el.childForFieldName('left');
        if (!key) continue;
        out.add({ names: [...ctx.names, nameOf(key)], type: 'variable', label: nameOf(key), startLine: el.startPosition.row + 1, startCol: el.startPosition.column, endLine: endLineOf(el), parent: ctx.parent });
      }
      return null;
    }
    if (nameNode.type !== 'identifier') return null;
    const name = nameNode.text;
    if (value && FUNCTION_VALUES.has(value.type)) {
      const names = [...ctx.names, name];
      out.add({ names, type: 'function', label: `${name}()`, startLine: line, startCol: col, endLine: end, parent: ctx.parent });
      const id = out.idOf(...names);
      return { names, parent: id, owner: id, anonClass: false };
    }
    if (exported || (value && VARIABLE_VALUES.has(value.type))) {
      out.add({ names: [...ctx.names, name], type: 'variable', label: name, startLine: line, startCol: col, endLine: end, parent: ctx.parent });
      return { ...ctx, inVar: true };
    }
    return null;
  };

  // judgment: namespaces, `declare` blocks and other wrappers are walked like plain blocks; they add no enclosing name.
  walkTree(tree.rootNode, (node, depth) => {
    if (!node.isNamed) return false;
    const type = node.type;
    types[depth] = type;
    const ctx = frames[depth - 1] ?? root;
    frames[depth] = ctx;
    switch (type) {
      case 'import_statement':
        onImport(node);
        return false;
      case 'export_statement': {
        const spec = stringValue(node.childForFieldName('source'));
        if (spec === null) return true;
        onReexport(node, spec);
        return false;
      }
      case 'call_expression':
        onCall(node, ctx);
        return true;
      case 'new_expression': {
        const p = calleeParts(node.childForFieldName('constructor'), out.source);
        if (p) out.addRef({ from: ctx.owner, name: p.name, receiver: p.receiver, kind: 'new', line: node.startPosition.row + 1 });
        return true;
      }
      case 'jsx_opening_element':
      case 'jsx_self_closing_element': {
        const nm = node.childForFieldName('name');
        if (nm?.type === 'identifier' && /^\p{Lu}/u.test(nm.text)) out.addRef({ from: ctx.owner, name: nm.text, receiver: null, kind: 'jsx', line: node.startPosition.row + 1 });
        else if (nm?.type === 'member_expression') {
          const p = calleeParts(nm, out.source);
          if (p) out.addRef({ from: ctx.owner, name: p.name, receiver: p.receiver, kind: 'jsx', line: node.startPosition.row + 1 });
        }
        return true;
      }
      case 'class_declaration':
      case 'abstract_class_declaration': {
        const nm = node.childForFieldName('name');
        if (!nm) return true;
        // judgment: graphify emits no node (nor member nodes) for a class declared inside a function body.
        if (ctx.owner !== root.owner || ctx.inVar) {
          heritageRefs(node, ctx.owner);
          frames[depth] = { ...ctx, anonClass: true };
          return true;
        }
        const frame = addSymbol(ctx, node, nm.text, 'class', true);
        if (!frame) return true;
        frames[depth] = frame;
        heritageRefs(node, frame.owner);
        return true;
      }
      case 'class': {
        // judgment: class expressions are not nodes (D11); their members are skipped so no id is invented.
        heritageRefs(node, ctx.owner);
        frames[depth] = { ...ctx, anonClass: true };
        return true;
      }
      case 'interface_declaration': {
        const nm = node.childForFieldName('name');
        if (!nm) return true;
        const frame = addSymbol(ctx, node, nm.text, 'interface');
        if (!frame) return true;
        frames[depth] = frame;
        // judgment: an interface's `extends` refs come from the interface node (D19 names no owner for interfaces).
        heritageRefs(node, out.idOf(...frame.names));
        return true;
      }
      case 'internal_module':
      case 'module': {
        // judgment: graphify keeps a node for `namespace NS {}` but members keep ids without NS (the walk adds no enclosing name); string-named `declare module 'x'` is a node labelled x.
        const nm = node.childForFieldName('name');
        if (nm) out.add({ names: [...ctx.names, nameOf(nm)], type: 'class', label: nameOf(nm), startLine: node.startPosition.row + 1, startCol: node.startPosition.column, endLine: endLineOf(node), parent: ctx.parent });
        return true;
      }
      case 'type_alias_declaration': {
        const nm = node.childForFieldName('name');
        if (nm) out.add({ names: [...ctx.names, nm.text], type: 'type', label: nm.text, startLine: node.startPosition.row + 1, startCol: node.startPosition.column, endLine: endLineOf(node), parent: ctx.parent });
        return false;
      }
      case 'enum_declaration': {
        const nm = node.childForFieldName('name');
        const body = node.childForFieldName('body');
        if (!nm) return true;
        const names = [...ctx.names, nm.text];
        out.add({ names, type: 'type', label: nm.text, startLine: node.startPosition.row + 1, startCol: node.startPosition.column, endLine: endLineOf(node), parent: ctx.parent });
        const enumId = out.idOf(...names);
        for (const m of body ? namedChildren(body) : []) {
          const key = m.type === 'enum_assignment' ? m.childForFieldName('name') : m.type === 'property_identifier' || m.type === 'string' ? m : null;
          if (!key) continue;
          out.add({ names: [...names, nameOf(key)], type: 'variable', label: nameOf(key), startLine: m.startPosition.row + 1, startCol: m.startPosition.column, endLine: endLineOf(m), parent: enumId });
        }
        return true;
      }
      case 'function_declaration':
      case 'generator_function_declaration': {
        const nm = node.childForFieldName('name');
        // judgment: a function declared inside a named variable's initializer (`const cb = x.map(() => { function f() {} })`) is no node.
        if (!nm || ctx.inVar) return true;
        const frame = addSymbol(ctx, node, nm.text, 'function');
        if (frame) frames[depth] = frame;
        return true;
      }
      case 'method_definition':
      case 'abstract_method_signature':
      case 'method_signature': {
        const parentType = types[depth - 1];
        // judgment: class overload signatures (`method_signature` in a class body) are not nodes, like function overloads;
        // private `#m()` methods are nodes because they are method definitions (only `#x` fields are excluded, D11).
        const ok = type === 'method_signature' ? parentType === 'interface_body' : parentType === 'class_body' && !ctx.anonClass;
        const nm = node.childForFieldName('name');
        if (!ok || !nm) return true;
        const frame = addSymbol(ctx, node, nameOf(nm), 'method');
        if (frame) frames[depth] = frame;
        return true;
      }
      case 'public_field_definition':
      case 'field_definition': {
        const nm = node.childForFieldName('name') ?? node.childForFieldName('property');
        const value = node.childForFieldName('value');
        if (types[depth - 1] !== 'class_body' || ctx.anonClass || !nm || nm.type === 'private_property_identifier' || !value || !FUNCTION_VALUES.has(value.type)) return true;
        const frame = addSymbol(ctx, node, nameOf(nm), 'method', true);
        if (frame) frames[depth] = frame;
        return true;
      }
      case 'variable_declarator': {
        const frame = onDeclarator(node, depth, ctx);
        if (frame) frames[depth] = frame;
        return true;
      }
      default:
        return true;
    }
  });
}
