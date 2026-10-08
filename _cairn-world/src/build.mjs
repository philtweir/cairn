// Build the Cairn world: CSV models + CSV data -> Alizarin graphs/resources -> static site.
//
//   npm run check   validate and build in memory, write nothing
//   npm run build   also write dist/data (Arches-format JSON) and dist/ (HTML)
//
// Authoring rules (see README.md): link cells hold ResourceIDs of the target rows,
// comma-separated; they are swapped for Alizarin's generated UUIDs here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as A from 'alizarin/inline-full';
import { parseCsv, toCsv } from './csv.mjs';
import { renderSite } from './render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const CHECK_ONLY = process.argv.includes('--check');

const RDM_NAMESPACE = 'http://cairn-world.example/rdm/';
const CRM = 'http://www.cidoc-crm.org/cidoc-crm/';
const CAIRN = 'http://cairn-world.example/ns/';
const NODE_COLS = ['alias', 'name', 'datatype', 'cardinality', 'ontology_class',
  'parent_property', 'parent_alias', 'collection_name'];
const LINK_TYPES = new Set(['resource-instance', 'resource-instance-list']);

const problems = [];
const problem = msg => problems.push(msg);
const rel = f => path.relative(ROOT, f);

// "E21_Person" -> CIDOC-CRM URI, "cairn:allied_with" -> our namespace, URIs pass through.
const expand = s => (!s ? s : /^https?:/.test(s) ? s : s.startsWith('cairn:') ? CAIRN + s.slice(6) : CRM + s);

function readTable(file) {
  const [header, ...rows] = parseCsv(fs.readFileSync(file, 'utf8'));
  return {
    header,
    rows: rows.map((cells, i) => ({
      line: i + 2,
      cells,
      get: Object.fromEntries(header.map((h, j) => [h, cells[j] ?? ''])),
    })),
  };
}

function report(file, diagnostics) {
  for (const d of diagnostics) {
    const msg = `${file}${d.line ? ':' + d.line : ''} ${d.message}`;
    if (d.level === "Error") problem(msg);
    else if (!d.message.includes(CAIRN)) console.warn(`warning: ${msg}`);
  }
}

await A.wasmReady;

// ---- 1. Models --------------------------------------------------------------

const vocabFile = path.join(ROOT, 'model/vocab.csv');
const vocabCsv = fs.readFileSync(vocabFile, 'utf8');

const models = readTable(path.join(ROOT, 'model/models.csv')).rows.map(r => {
  const m = { alias: r.get.alias, name: r.get.name, ontology: expand(r.get.ontology_class) };
  const file = path.join(ROOT, `model/${m.alias}.csv`);
  m.file = file;
  m.nodes = readTable(file).rows.map(n => ({ ...n.get, line: n.line }));
  return m;
});
const modelByAlias = Object.fromEntries(models.map(m => [m.alias, m]));

for (const m of models) {
  for (const n of m.nodes) {
    n.targets = (n.target_model || '').split('|').filter(Boolean);
    if (LINK_TYPES.has(n.datatype) && !n.targets.length) problem(`${rel(m.file)}:${n.line} link node "${n.alias}" needs target_model`);
    for (const t of n.targets) if (!modelByAlias[t]) problem(`${rel(m.file)}:${n.line} unknown target_model "${t}"`);
  }
  const graphCsv = toCsv([['name', 'alias', 'ontology_class'], [m.name, m.alias, m.ontology]]);
  const nodesCsv = toCsv([NODE_COLS, ...m.nodes.map(n => NODE_COLS.map(c =>
    (c === 'ontology_class' || c === 'parent_property') ? expand(n[c]) : n[c]))]);
  report(rel(m.file), A.validateModelCsvs(graphCsv, nodesCsv, vocabCsv));
  try {
    m.built = A.buildGraphFromModelCsvs(graphCsv, nodesCsv, RDM_NAMESPACE, vocabCsv);
  } catch (e) {
    problem(`${rel(m.file)} build failed: ${e?.message ?? JSON.stringify(e)}`);
  }
}
if (problems.length) bail();

// Link nodes must declare which graphs they point at, or the ORM can't follow them.
for (const m of models) {
  for (const n of m.nodes) {
    if (!LINK_TYPES.has(n.datatype)) continue;
    const node = m.built.graph.nodes.find(x => x.alias === n.alias);
    node.config = {
      graphs: n.targets.map(t => ({
        graphid: modelByAlias[t].built.graph.graphid, name: modelByAlias[t].name,
        ontologyProperty: '', inverseOntologyProperty: '', relationshipType: '',
      })),
    };
  }
}

// ---- 2. Data ----------------------------------------------------------------

const businessCsv = (m, table, linkIds) => {
  const cols = table.header;
  return toCsv([cols, ...table.rows.map(r => cols.map((c, j) => (linkIds ? linkIds(m, c, r) : r.cells[j] ?? '')))]);
};
const isLinkCol = (m, col) => LINK_TYPES.has(m.nodes.find(n => n.alias === col)?.datatype);

for (const m of models) {
  const file = path.join(ROOT, `data/${m.alias}.csv`);
  m.dataFile = file;
  m.table = fs.existsSync(file) ? readTable(file) : { header: ['ResourceID'], rows: [] };
  if (m.table.header[0] !== 'ResourceID') problem(`${rel(file)} first column must be ResourceID`);
  for (const c of m.table.header.slice(1)) {
    if (!m.nodes.some(n => n.alias === c)) problem(`${rel(file)} unknown column "${c}" (not in model/${m.alias}.csv)`);
  }
}
if (problems.length) bail();

// Pass 1: build without link columns, only to learn the UUID Alizarin assigns each ResourceID.
const idOf = {};
for (const m of models) {
  idOf[m.alias] = new Map();
  const keep = m.table.header.map((c, j) => (j === 0 || !isLinkCol(m, c)) ? j : -1).filter(j => j >= 0);
  const text = toCsv([keep.map(j => m.table.header[j]), ...m.table.rows.map(r => keep.map(j => r.cells[j] ?? ''))]);
  const out = safeBuild(m, text, rel(m.dataFile));
  if (!out) continue;
  out.forEach((res, i) => {
    const key = m.table.rows[i].cells[0];
    if (idOf[m.alias].has(key)) problem(`${rel(m.dataFile)}:${m.table.rows[i].line} duplicate ResourceID "${key}"`);
    idOf[m.alias].set(key, res.resourceinstance.resourceinstanceid);
  });
}
if (problems.length) bail();

// Pass 2: swap link keys for UUIDs and build for real.
const resources = {};
for (const m of models) {
  const text = businessCsv(m, m.table, (mm, col, row) => {
    const raw = row.get[col] ?? '';
    if (col === 'ResourceID' || !isLinkCol(mm, col)) return raw;
    const node = mm.nodes.find(n => n.alias === col);
    const keys = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (node.cardinality === '1' && keys.length > 1) problem(`${rel(mm.dataFile)}:${row.line} "${col}" takes one link, got ${keys.length}`);
    return keys.map(k => {
      const hits = node.targets.filter(t => idOf[t].has(k));
      if (hits.length !== 1) {
        problem(`${rel(mm.dataFile)}:${row.line} "${col}" -> "${k}" ${hits.length ? 'is ambiguous between ' + hits.join(', ') : 'not found in ' + node.targets.join('|')}`);
        return '';
      }
      return idOf[hits[0]].get(k);
    }).join(',');
  });
  resources[m.alias] = safeBuild(m, text, rel(m.dataFile)) ?? [];
}
if (problems.length) bail();

// The CSV loader stores SKOS concept ids in concept tiles, but the ORM (like Arches itself)
// looks concepts up by value id. Translate, or every concept field reads back empty.
const valueIdOfConcept = new Map();
for (const m of models) {
  for (const c of m.built.collections) {
    for (const [conceptId, concept] of Object.entries(c.__allConcepts ?? {})) {
      valueIdOfConcept.set(conceptId, Object.values(concept.prefLabels)[0].id);
    }
  }
}
for (const m of models) {
  const conceptNodes = m.built.graph.nodes.filter(n => n.datatype === 'concept' || n.datatype === 'concept-list').map(n => n.nodeid);
  for (const res of resources[m.alias]) {
    for (const tile of res.tiles) {
      for (const nodeid of conceptNodes) {
        const v = tile.data?.[nodeid];
        if (v == null) continue;
        const swap = id => valueIdOfConcept.get(id) ?? id;
        tile.data[nodeid] = Array.isArray(v) ? v.map(swap) : swap(v);
      }
    }
  }
}

function safeBuild(m, csv, label) {
  try {
    return A.buildResourcesFromBusinessCsv(csv, m.built.graph, m.built.collections).business_data.resources;
  } catch (e) {
    problem(`${label} ${String(e?.message ?? e).trim()}`);
    return null;
  }
}

function bail() {
  console.error(problems.map(p => `error: ${p}`).join('\n'));
  console.error(`\n${problems.length} problem(s); nothing written.`);
  process.exit(1);
}

const total = Object.values(resources).reduce((n, r) => n + r.length, 0);
console.log(`ok: ${models.length} models, ${total} resources`);
if (CHECK_ONLY) process.exit(0);

// ---- 3. Write Arches-format data (usable by Alizarin's static/local clients) --

fs.rmSync(DIST, { recursive: true, force: true });
for (const d of ['graphs', 'resources', 'collections']) fs.mkdirSync(path.join(DIST, 'data', d), { recursive: true });
const write = (f, obj) => fs.writeFileSync(path.join(DIST, 'data', f), JSON.stringify(obj));

const graphMeta = {}, resourceFiles = {}, seenCollections = new Set();
for (const m of models) {
  const g = m.built.graph;
  const { nodes, edges, nodegroups, cards, cards_x_nodes_x_widgets, functions_x_graphs, root, publication, ...meta } = g;
  graphMeta[g.graphid] = meta;
  write(`graphs/${g.graphid}.json`, { graph: [g] });
  resourceFiles[g.graphid] = resources[m.alias].map(r => {
    const f = `resources/${r.resourceinstance.resourceinstanceid}.json`;
    write(f, { business_data: { resources: [r] } });
    return f;
  });
  for (const c of m.built.collections) {
    if (seenCollections.has(c.id)) continue;
    seenCollections.add(c.id);
    write(`collections/${c.id}.json`, c);
  }
}
write('graphs.json', { models: graphMeta });
write('index.json', resourceFiles);

// ---- 4. Read it back through the ORM, as a display site would ----------------

const { client, graphManager, staticStore, RDM } = A;
const dataPath = f => path.join(DIST, 'data', f);
const archesClient = new client.ArchesClientLocal({
  allGraphFile: () => dataPath('graphs.json'),
  graphToGraphFile: meta => dataPath(`graphs/${meta.graphid}.json`),
  graphIdToGraphFile: id => dataPath(`graphs/${id}.json`),
  graphIdToResourcesFiles: id => (resourceFiles[id] ?? []).map(dataPath),
  resourceIdToFile: id => dataPath(`resources/${id}.json`),
  collectionIdToFile: id => dataPath(`collections/${id}.json`),
});
graphManager.archesClient = archesClient;
staticStore.archesClient = archesClient;
RDM.archesClient = archesClient;
await graphManager.initialize();

const isNull = v => v === null || v === undefined;

// Cardinality-n nodes come back as one list per tile, each item possibly a list itself.
async function leaves(v, isLeaf) {
  const out = [];
  for (const item of Array.from(v)) {
    const x = await item;
    if (isNull(x)) continue;
    if (isLeaf(x)) out.push(x);
    else if (typeof x[Symbol.iterator] === 'function') out.push(...await leaves(x, isLeaf));
  }
  return out;
}

async function readField(entity, node) {
  const v = await entity[node.alias];
  if (isNull(v)) return null;
  switch (node.datatype) {
    case 'number': return Number(v);
    case 'concept-list': return (await leaves(v, x => typeof x === 'string' || x instanceof String)).map(String);
    case 'resource-instance': return [(await v).id];
    case 'resource-instance-list': return (await leaves(v, x => typeof x.id === 'string')).map(x => x.id);
    default: { const s = String(v); return s === '' ? null : s; }
  }
}

const entities = [];
const classNames = [...graphManager.wkrms.keys()];
for (const m of models) {
  const className = classNames.find(k => k.toLowerCase() === m.name.toLowerCase());
  if (!className) throw new Error(`ORM has no model for ${m.name} (have ${classNames.join(', ')})`);
  const all = await (await graphManager.get(className)).all();
  const keyOfId = new Map([...idOf[m.alias]].map(([k, id]) => [id, k]));
  for (const e of all) {
    const fields = [];
    for (const n of m.nodes) fields.push({ alias: n.alias, label: n.name, datatype: n.datatype, targets: n.targets, value: await readField(e, n) });
    entities.push({ model: m.alias, id: e.id, key: keyOfId.get(e.id), fields });
  }
}

renderSite({ models: models.map(m => ({ alias: m.alias, name: m.name })), entities, outDir: DIST });
console.log(`wrote ${rel(DIST)}/ (${entities.length} pages) and ${rel(DIST)}/data/`);
