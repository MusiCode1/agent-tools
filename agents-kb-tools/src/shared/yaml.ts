import { parseDocument, isMap, isSeq, isScalar, isAlias, type Document, type ScalarTag } from 'yaml';

const floats = new WeakMap<object, Set<string>>();
const scalarSources = new WeakMap<object, Map<string,string>>();
export function scalarSource(parent: object, key: string): string | undefined { return scalarSources.get(parent)?.get(key); }

/** Preserve the int/float distinction used by the Python contract validators. */
export function isIntegerField(object: Record<string, unknown>, key: string): boolean {
  return typeof object[key] === 'number' && Number.isInteger(object[key]) && !floats.get(object)?.has(key);
}

export function annotateNumericKinds(node: unknown, value: unknown, document?: Document, trail = new Set<unknown>()): void {
  if (!node || trail.has(node)) return;
  trail.add(node);
  try {
    if (isAlias(node) && document) {
      annotateNumericKinds(node.resolve(document),value,document,trail);
      return;
    }
    const remember = (parent: object, key: string, syntax: unknown, child: unknown) => {
      floats.get(parent)?.delete(key);
      if (!isScalar(syntax)) return;
      const source = syntax.source ?? '';
      const entries = scalarSources.get(parent) ?? new Map<string,string>();
      entries.set(key,source);
      scalarSources.set(parent,entries);
      if (child instanceof Date) {
        Object.defineProperty(child,'__yamlSource',{value:source,configurable:true});
        Object.defineProperty(child,'__yamlDateOnly',{value:/^\d{4}-\d\d-\d\d$/.test(source),configurable:true});
      }
      if (typeof syntax.value === 'number') {
        const integerFormat = ['HEX','BIN','OCT'].includes(syntax.format ?? '');
        if (syntax.tag === 'tag:yaml.org,2002:float' || syntax.format === 'EXP' || (!integerFormat && /[.eE]/.test(source))) {
          const keys = floats.get(parent) ?? new Set<string>();
          keys.add(key); floats.set(parent,keys);
        }
      }
    };
    if (isMap(node) && value && typeof value === 'object') {
      const merged = node.items.filter(pair=>isScalar(pair.key) && typeof pair.key.value === 'symbol');
      // YAML merge precedence: earlier maps win, and explicit fields win last.
      for (const pair of merged) {
        const entries = isSeq(pair.value) ? [...pair.value.items].reverse() : [pair.value];
        for (const entry of entries) annotateNumericKinds(entry,value,document,trail);
      }
      for (const pair of node.items) {
        if (merged.includes(pair)) continue;
        const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
        const child = (value as Record<string,unknown>)[key];
        remember(value,key,pair.value,child);
        annotateNumericKinds(pair.value,child,document,trail);
      }
    } else if (isSeq(node) && Array.isArray(value)) {
      node.items.forEach((child,i)=>{remember(value,String(i),child,value[i]); annotateNumericKinds(child,value[i],document,trail);});
    }
  } finally {trail.delete(node);}
}

export function parseYaml(text: string): unknown {
  const document = parseDocument(text, {
    version: '1.1', uniqueKeys: false,
    customTags: tags => tags.map(tag => {
      if (typeof tag !== 'object' || !('test' in tag)) return tag;
      if (tag.tag === 'tag:yaml.org,2002:bool') {
        return {...tag, test: tag.test?.test('true')
          ? /^(?:yes|Yes|YES|true|True|TRUE|on|On|ON)$/
          : /^(?:no|No|NO|false|False|FALSE|off|Off|OFF)$/} as ScalarTag;
      }
      if (tag.tag === 'tag:yaml.org,2002:int' && !('format' in tag)) {
        return {...tag, test: /^[-+]?(?:0|[1-9][0-9_]*)$/} as ScalarTag;
      }
      if (tag.tag === 'tag:yaml.org,2002:float' && 'format' in tag && tag.format === 'EXP') {
        return {...tag, test: /^[-+]?(?:[0-9][0-9_]*\.[0-9_]*|\.[0-9_]+)[eE][-+][0-9]+$/} as ScalarTag;
      }
      return tag;
    }),
  });
  if (document.errors.length) throw document.errors[0];
  const value: unknown = document.toJS({ maxAliasCount: 100 });
  annotateNumericKinds(document.contents, value, document);
  return value;
}
