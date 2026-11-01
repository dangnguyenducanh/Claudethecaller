// Synthetic fixture for graph.ids: TypeScript shapes the real fixtures do not cover.
import { readFileSync } from 'node:fs';
import type { Stats } from 'node:fs';

export enum Colour { Red, Green }

export interface Shape {
  area(): number;
  readonly name: string;
}

export abstract class Base implements Shape {
  abstract area(): number;
  get name(): string { return 'base'; }
  static create(): Base { return new Square(2); }
}

export class Square extends Base {
  #side: number;
  constructor(side: number) { super(); this.#side = side; }
  area(): number { return this.#side ** 2; }
  scale = (k: number): Square => new Square(this.#side * k);
}

export type Pair<T> = [T, T];

export function* walk(n: number): Generator<number> { for (let i = 0; i < n; i++) yield i; }

export const limits = { max: 3 } as const;
export const LIMIT = 3;
const quiet = 1;

export const größe = (s: Stats): number => s.size;

export default function main(path: string): number {
  function inner(): string { return readFileSync(path, 'utf8'); }
  return inner().length + quiet;
}
