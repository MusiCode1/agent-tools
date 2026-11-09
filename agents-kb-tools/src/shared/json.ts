import { parseDocument } from 'yaml';
import { annotateNumericKinds } from './yaml.js';

/** JSON syntax stays strict; the syntax tree only retains lexical numeric types. */
export function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  annotateNumericKinds(parseDocument(text, {version: '1.2', uniqueKeys: false}).contents, value);
  return value;
}
