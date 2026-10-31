/**
 * Memory text hash: the identity of a memory within (user, scope, project).
 *
 * Called from: the Python-to-TypeScript importer (repositories/admin/from-python.ts) and, later, every memory write (T4.2), so
 * imported and live rows agree on what "the same memory" means.
 * Deliberately NOT done: any hashing of metadata, salting, or a different digest per call site.
 */
import { createHash } from 'node:crypto';

/** sha256 hex of `text` after NFKC normalization, trim, whitespace collapse and lowercase. Pure; never throws for a string. */
export function memoryHash(text: string): string {
  const normal = text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  return createHash('sha256').update(normal).digest('hex');
}
