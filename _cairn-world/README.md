# cairn-world

A Cairn campaign world kept as plain CSV, built into an [Alizarin](https://github.com/flaxandteal/alizarin)
graph (Arches resource models, CIDOC-CRM ontology) and rendered as a small static site.

Lives under `_cairn-world/` so the Jekyll rules site ignores it. It is self-contained and can be
lifted into its own repo as-is.

```sh
npm install
npm run check    # validate everything, write nothing
npm run build    # write dist/ (HTML) and dist/data/ (Arches-format JSON)
npm run import-rules   # regenerate rules/ from the Cairn markdown (needs the cairn repo)
npm run serve    # http://localhost:8000
```

Needs Node 22+. Alizarin is pinned to `2.0.0-beta.9` (the default npm tag is a stale 1.0.0 with no
CSV support). Alizarin is AGPL-3.0; keep that in mind before publishing anything built on it.

## Layout

| Path | What |
|---|---|
| `model/models.csv` | One row per model: `alias,name,ontology_class` |
| `model/<alias>.csv` | That model's fields (see below) |
| `model/vocab.csv` | Controlled vocabularies: `collection_name,concept_label` |
| `data/<alias>.csv` | The world itself, one row per entry |
| `rules/<alias>.csv` | Generated reference data from the Cairn rules (see below); never edit |
| `src/` | Build script, rules importer, CSV helpers, HTML renderer |

## Ontology

A deliberately small CIDOC-CRM subset. Models come in two kinds: *instances* (your campaign) and
*types* (the rules), and instances point at their type with `P2 has type`.

| Instances | CRM class | Types | CRM class |
|---|---|---|---|
| Place | E53 Place | Background | E55 Type |
| Faction | E74 Group | Monster Type | E55 Type |
| NPC | E21 Person | Item Type | E55 Type |
| Creature | E20 Biological Object | Vocabularies (SKOS) | E55 Type |
| Relic | E22 Human-Made Object | | |
| Event | E5 Event | | |

Links: NPC -> Background and Stat block (Monster Type); Creature -> Monster Type; Relic -> Item
Type. Every type page lists the campaign entries that use it ("Linked from"). Other CRM properties
used: P89 falls within, P7 took place at, P11 had participant, P55 has current location, P52 has
current owner, P107i member of, P74 residence. Faction alliances and enmities have no CRM
equivalent, so they use `cairn:allied_with` / `cairn:hostile_to`. Cairn stats are plain number
fields; no ontology covers game mechanics.

## Rules data (`rules/`)

`npm run import-rules` reads a Cairn checkout (default: the parent directory) and writes:

| File | Source | Rows |
|---|---|---|
| `monstertype.csv` | `resources/monsters/*.md` (1st-edition stat lines) | 145 |
| `background.csv` | `second-edition/backgrounds/*.md` (names, starting gear) | 20 |
| `itemtype.csv` | `second-edition/players-guide/marketplace.md` (armor, weapons, transport) | 27 |

Not imported: the d6 origin tables, 2e bestiary prose, spells, services and hirelings. Gear is kept
as text on Background, not linked to Item Types. The source text is CC-BY-SA 4.0; each row has a
`source` field, and anything you publish built from it must credit and share alike.

Campaign-specific types (a "Bell" item) go in `data/<alias>.csv`; rules and data rows merge, and
keys must be unique across both.

## Authoring

**Add an entry:** append a row to `data/<alias>.csv`. `ResourceID` is your own stable slug
(`old-marta`); it also becomes the page filename.

**Link entries:** put the target's `ResourceID` in the link cell. Several links go in one quoted
cell, comma-separated: `"old-marta,ferrymen"`. The build swaps these for Alizarin's UUIDs and
errors on unknown or ambiguous keys.

**Add a field:** add a row to `model/<alias>.csv`, then a column of the same alias in the data.

| Column | Meaning |
|---|---|
| `alias` | Field key; also the data CSV column name |
| `datatype` | `string`, `number`, `concept`, `concept-list`, `resource-instance-list` |
| `cardinality` | `1` or `n` |
| `ontology_class`, `parent_property` | CRM names (`E41_Appellation`), full URIs, or `cairn:` terms |
| `collection_name` | For concept fields: which vocabulary in `vocab.csv` |
| `target_model` | For links: model alias, or `npc\|faction` for several |

Declare every link as `resource-instance-list`, even single-valued ones: with the CSV loader the
single `resource-instance` type stores a bare string that the ORM does not follow.

**Add a vocabulary term:** add a row to `model/vocab.csv`. Concept cells in the data must match a
label exactly.

## Gotchas found while building this

- The CSV loader stores SKOS *concept* ids in tiles; the ORM looks up *value* ids (as Arches
  does). `build.mjs` translates, otherwise every concept field reads back empty.
- Link nodes need `config.graphs` set to their target graph(s); `build.mjs` does it from `target_model`.
- The `ArchesClientLocal` graph index (`graphs.json`) wants trimmed metadata, not full graphs.
- Cardinality-`n` fields come back from the ORM as a list of lists; the reader flattens them.
- The ORM names models in PascalCase (`NPC` -> `Npc`).
- Warnings about non-CRM properties are suppressed for the `cairn:` namespace only.
- This is beta software; expect to re-check these when bumping the version.

## Using the data elsewhere

`dist/data/` is plain Arches-format JSON (`graphs.json`, `graphs/`, `resources/`, `collections/`,
plus `index.json` mapping each graph to its resource files). Alizarin's `ArchesClientLocal` (Node)
and `ArchesClientRemoteStatic` (browser, same callback layout) can read it; `src/build.mjs` shows
the wiring.
