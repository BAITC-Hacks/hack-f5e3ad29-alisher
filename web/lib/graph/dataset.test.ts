import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Papa from 'papaparse';
import { readDataset } from './dataset';
import { DATA_FILES, type DatasetBytes, type MoneyDataset } from './types';
import { getGraphView, MAX_GRAPH_EDGES, MAX_GRAPH_NODES } from './view';

let bytes: DatasetBytes;
let dataset: MoneyDataset;
before(async () => {
  const entries = await Promise.all(
    DATA_FILES.map(async (name) => [
      name,
      Uint8Array.from(
        await readFile(new URL(`../../public/data/${name}`, import.meta.url)),
      ).buffer,
    ]),
  );
  bytes = Object.fromEntries(entries) as DatasetBytes;
  dataset = await readDataset(bytes);
});

function changeCsv(
  name: 'nodes_roles.csv' | 'top_nodes.csv' | 'clusters.csv',
  mutate: (rows: Record<string, string>[]) => void,
): DatasetBytes {
  const rows = Papa.parse<Record<string, string>>(
    new TextDecoder().decode(bytes[name]),
    { header: true, skipEmptyLines: true },
  ).data;
  mutate(rows);
  return {
    ...bytes,
    [name]: new TextEncoder().encode(Papa.unparse(rows)).buffer,
  };
}

test('reads the real ZSTD Parquet together with OUT without losing int64 IDs or isolated nodes', () => {
  assert.equal(dataset.nodes.length, 2248);
  assert.equal(new Set(dataset.nodes.map((n) => n.id)).size, 2248);
  assert.equal(dataset.edges.length, 3119);
  assert.equal(dataset.transactions.length, 4840);
  assert.equal(dataset.clusters.length, 88);
  assert.equal(dataset.top.length, 30);
  assert.equal(dataset.top[0].id, '100000004015047100');
  assert.equal(
    dataset.nodes.filter((n) => n.inDegree + n.outDegree === 0).length,
    19,
  );
  assert.equal(dataset.nodes.filter((n) => n.isSeed).length, 81);
  assert.deepEqual(dataset.period, { start: '2026-07-01', end: '2026-07-31' });
  assert.ok(Math.abs(dataset.totalAmount - 365890012.01) < 0.01);
});

test('preserves unknown pass-through ratios and the depth boundary', () => {
  const boundary = dataset.nodes.filter((n) => n.depth === 4);
  assert.equal(boundary.length, 444);
  assert.ok(boundary.every((n) => n.passThrough === null));
  assert.ok(
    dataset.nodes.filter((n) => n.isSeed).every((n) => n.passThrough === null),
  );
  assert.equal(
    dataset.nodes.find((n) => n.id === '100000002398779100')?.inAmount,
    1095690,
  );
});

test('rejects mixing analysis results with a different input graph', async () => {
  const changed = changeCsv('nodes_roles.csv', (rows) => {
    rows[0].in_kzt = String(Number(rows[0].in_kzt) + 100);
  });
  await assert.rejects(readDataset(changed), /IN и OUT не совпадают/);
});

test('rejects duplicate identifiers rather than merging or dropping records', async () => {
  const changed = changeCsv('nodes_roles.csv', (rows) => {
    rows[1].gid = rows[0].gid;
  });
  await assert.rejects(readDataset(changed), /повторяющийся gid/);
});

test('rejects a stale or reordered review queue', async () => {
  const changed = changeCsv('top_nodes.csv', (rows) => {
    [rows[0], rows[1]] = [rows[1], rows[0]];
  });
  await assert.rejects(readDataset(changed), /топ не соответствует/);
});

test('rejects incorrect cluster memberships and totals', async () => {
  const changed = changeCsv('clusters.csv', (rows) => {
    rows[0].n_nodes = '1';
  });
  await assert.rejects(readDataset(changed), /не совпадает с графом/);
});

test('shows a bounded graph while keeping the full dataset searchable', () => {
  const view = getGraphView(dataset, '', null, false);
  const ids = new Set(view.nodes.map((node) => node.id));
  assert.equal(view.nodes.length, MAX_GRAPH_NODES);
  assert.ok(view.edges.length <= MAX_GRAPH_EDGES);
  assert.ok(dataset.top.every((entry) => ids.has(entry.id)));
  assert.ok(
    view.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target)),
  );
});

test('search selection reveals a node outside the initial graph and its neighbors', () => {
  const initial = getGraphView(dataset, '', null, false);
  const initialIds = new Set(initial.nodes.map((node) => node.id));
  const selected = dataset.nodes.find(
    (node) => !initialIds.has(node.id) && node.inDegree + node.outDegree > 0,
  )!;
  const view = getGraphView(dataset, '', selected.id, true);
  const ids = new Set(view.nodes.map((node) => node.id));
  const neighborIds = new Set(
    dataset.edges.flatMap((edge) =>
      edge.source === selected.id
        ? [edge.target]
        : edge.target === selected.id
          ? [edge.source]
          : [],
    ),
  );
  assert.ok(ids.has(selected.id));
  assert.ok(view.nodes.length <= MAX_GRAPH_NODES);
  assert.ok(
    view.nodes.every(
      (node) => node.id === selected.id || neighborIds.has(node.id),
    ),
  );
  assert.ok(
    view.edges.some(
      (edge) => edge.source === selected.id || edge.target === selected.id,
    ),
  );
});

test('cluster filter restricts the graph to that cluster', () => {
  const cluster = dataset.clusters[0].id;
  const view = getGraphView(dataset, cluster, null, false);
  assert.ok(view.nodes.every((node) => node.cluster === cluster));
});
