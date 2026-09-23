import Papa from 'papaparse';
import { parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import {
  ROLES,
  type DatasetBytes,
  type MoneyDataset,
  type MoneyNode,
  type Role,
} from './types';

type Row = Record<string, unknown>;
type Table = { rows: Row[]; name: string };

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function field(row: Row, key: string, context: string): unknown {
  check(
    key in row &&
      row[key] !== null &&
      row[key] !== undefined &&
      row[key] !== '',
    `${context}: отсутствует ${key}`,
  );
  return row[key];
}

function text(row: Row, key: string, context: string) {
  return String(field(row, key, context));
}

function id(row: Row, key: string, context: string) {
  const value = field(row, key, context);
  check(
    typeof value !== 'number' || Number.isSafeInteger(value),
    `${context}: ${key} потерял точность; нужен исходный int64`,
  );
  const result = String(value);
  check(/^-?\d+$/.test(result), `${context}: неверный ${key}`);
  return BigInt(result).toString();
}

function num(row: Row, key: string, context: string, max = Infinity) {
  const value = Number(field(row, key, context));
  check(
    Number.isFinite(value) && value >= 0 && value <= max,
    `${context}: некорректный ${key}`,
  );
  return value;
}

function integer(row: Row, key: string, context: string, max = Infinity) {
  const value = num(row, key, context, max);
  check(Number.isSafeInteger(value), `${context}: ${key} должен быть целым`);
  return value;
}

function bool(row: Row, key: string, context: string) {
  const value = field(row, key, context);
  check(
    typeof value === 'boolean' ||
      value === 'True' ||
      value === 'False' ||
      value === 'true' ||
      value === 'false',
    `${context}: неверный ${key}`,
  );
  return value === true || value === 'True' || value === 'true';
}

function csv(bytes: ArrayBuffer, name: string): Table {
  const result = Papa.parse<Row>(new TextDecoder().decode(bytes), {
    header: true,
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
    transformHeader: (value) => value.trim(),
  });
  check(
    !result.errors.length,
    `${name}: ${result.errors[0]?.message || 'ошибка CSV'} (строка ${(result.errors[0]?.row ?? 0) + 2})`,
  );
  check(
    !result.meta.renamedHeaders ||
      !Object.keys(result.meta.renamedHeaders).length,
    `${name}: повторяющиеся колонки`,
  );
  return { name, rows: result.data };
}

async function parquet(bytes: ArrayBuffer, name: string): Promise<Table> {
  try {
    return {
      name,
      rows: await parquetReadObjects({ file: bytes, compressors }),
    };
  } catch (error) {
    throw new Error(
      `${name}: не удалось прочитать Parquet — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function keyed(table: Table, key: string) {
  const result = new Map<string, Row>();
  table.rows.forEach((row, index) => {
    const value = id(row, key, `${table.name}, строка ${index + 2}`);
    check(!result.has(value), `${table.name}: повторяющийся ${key} ${value}`);
    result.set(value, row);
  });
  return result;
}

const pair = (a: string, b: string) => `${a}>${b}`;
const sameAmount = (a: number, b: number) => Math.abs(a - b) <= 0.011;

/** The graph never recalculates analytical roles: these are joined from the supplied OUT. */
export async function readDataset(
  bytes: DatasetBytes,
  progress: (message: string) => void = () => {},
): Promise<MoneyDataset> {
  progress('Читаем Parquet и результаты анализа…');
  const [registry, rawEdges, rawTransactions] = await Promise.all([
    parquet(bytes['nodes.parquet'], 'nodes.parquet'),
    parquet(bytes['edges.parquet'], 'edges.parquet'),
    parquet(bytes['transactions.parquet'], 'transactions.parquet'),
  ]);
  const rawRoles = csv(bytes['nodes_roles.csv'], 'nodes_roles.csv');
  const rawClusters = csv(bytes['clusters.csv'], 'clusters.csv');
  const rawTop = csv(bytes['top_nodes.csv'], 'top_nodes.csv');
  const base = keyed(registry, 'gid'),
    roles = keyed(rawRoles, 'gid');
  check(base.size > 0, 'nodes.parquet: реестр узлов пуст');
  check(base.size === roles.size, 'IN и OUT не совпадают: разное число узлов');
  progress('Проверяем узлы, связи и соответствие IN / OUT…');
  const nodes: MoneyNode[] = [...base].map(([gid, row]) => {
    const r = roles.get(gid),
      context = `nodes_roles.csv, gid ${gid}`;
    check(r, `nodes_roles.csv: нет результата для ${gid}`);
    const role = text(r, 'role', context);
    check(ROLES.includes(role as Role), `${context}: неизвестная роль ${role}`);
    const depth = integer(row, 'depth', 'nodes.parquet', 4),
      isSeed = bool(row, 'is_seed', 'nodes.parquet');
    check(
      depth === integer(r, 'depth', context, 4) &&
        isSeed === bool(r, 'is_seed', context),
      `${context}: глубина или seed не совпадает с IN`,
    );
    check(
      isSeed === (depth === 0),
      `nodes.parquet, gid ${gid}: seed должен иметь depth=0`,
    );
    return {
      id: gid,
      role: role as Role,
      roleScore: num(r, 'role_score', context, 1),
      priority: num(r, 'priority_score', context, 1),
      cluster: id(r, 'cluster_id', context),
      evidence: text(r, 'evidence', context),
      depth,
      isSeed,
      inAmount: num(r, 'in_kzt', context),
      outAmount: num(r, 'out_kzt', context),
      inDegree: integer(r, 'in_deg', context),
      outDegree: integer(r, 'out_deg', context),
      inTx: integer(r, 'in_tx', context),
      outTx: integer(r, 'out_tx', context),
      passThrough:
        r.pass_through === '' || r.pass_through === null
          ? null
          : num(r, 'pass_through', context),
      seedReach: integer(r, 'seed_reach', context),
      matchedShare: num(r, 'matched_2d_share', context, 1),
    };
  });
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const edgeIds = new Set<string>();
  const flows = new Map(
    nodes.map((n) => [
      n.id,
      {
        inAmount: 0,
        outAmount: 0,
        inTx: 0,
        outTx: 0,
        inDegree: 0,
        outDegree: 0,
      },
    ]),
  );
  const edges = rawEdges.rows.map((row, i) => {
    const context = `edges.parquet, строка ${i + 1}`,
      source = id(row, 'src', context),
      target = id(row, 'dst', context);
    check(
      base.has(source) && base.has(target),
      `${context}: ребро ссылается на неизвестный gid`,
    );
    const edgeId = pair(source, target);
    check(!edgeIds.has(edgeId), `${context}: повторяющееся ребро`);
    edgeIds.add(edgeId);
    const amount = num(row, 'sum_kzt', context),
      count = integer(row, 'n_tx', context);
    check(
      count > 0 && amount > 0,
      `${context}: сумма и число переводов должны быть положительными`,
    );
    const from = flows.get(source)!,
      to = flows.get(target)!;
    from.outAmount += amount;
    from.outTx += count;
    from.outDegree++;
    to.inAmount += amount;
    to.inTx += count;
    to.inDegree++;
    return { id: edgeId, source, target, amount, count };
  });
  for (const node of nodes) {
    const flow = flows.get(node.id)!;
    check(
      sameAmount(node.inAmount, flow.inAmount) &&
        sameAmount(node.outAmount, flow.outAmount) &&
        node.inDegree === flow.inDegree &&
        node.outDegree === flow.outDegree &&
        node.inTx === flow.inTx &&
        node.outTx === flow.outTx,
      `IN и OUT не совпадают: суммы или связи узла ${node.id}`,
    );
  }
  const txByPair = new Map<string, { amount: number; count: number }>();
  const transactions = rawTransactions.rows.map((row, i) => {
    const context = `transactions.parquet, строка ${i + 1}`,
      source = id(row, 'src', context),
      target = id(row, 'dst', context);
    check(base.has(source) && base.has(target), `${context}: неизвестный gid`);
    const amount = num(row, 'sum_kzt', context),
      rawDate = field(row, 'date', context);
    const date = rawDate instanceof Date ? rawDate : new Date(String(rawDate));
    check(Number.isFinite(date.getTime()), `${context}: некорректная дата`);
    const key = pair(source, target),
      agg = txByPair.get(key) ?? { amount: 0, count: 0 };
    agg.amount += amount;
    agg.count++;
    txByPair.set(key, agg);
    return { source, target, amount, date: date.toISOString().slice(0, 10) };
  });
  check(
    txByPair.size === edges.length,
    'edges.parquet и transactions.parquet: разные пары переводов',
  );
  for (const edge of edges) {
    const agg = txByPair.get(edge.id);
    check(
      agg && agg.count === edge.count && sameAmount(agg.amount, edge.amount),
      `edges.parquet и transactions.parquet: не совпадают переводы ${edge.source} → ${edge.target}`,
    );
  }
  const clusterMap = keyed(rawClusters, 'cluster_id');
  const internal = new Map<string, number>();
  for (const e of edges) {
    const c = nodeMap.get(e.source)!.cluster;
    if (c === nodeMap.get(e.target)!.cluster)
      internal.set(c, (internal.get(c) ?? 0) + e.amount);
  }
  const members = new Map<string, MoneyNode[]>();
  for (const n of nodes) {
    check(
      clusterMap.has(n.cluster),
      `clusters.csv: отсутствует кластер ${n.cluster}`,
    );
    const group = members.get(n.cluster) ?? [];
    group.push(n);
    members.set(n.cluster, group);
  }
  const clusters = [...clusterMap].map(([cid, row]) => {
    const context = `clusters.csv, кластер ${cid}`,
      group = members.get(cid) ?? [];
    const count = integer(row, 'n_nodes', context),
      seedCount = integer(row, 'n_seed', context),
      amount = num(row, 'sum_kzt_internal', context);
    check(
      count > 0 &&
        group.length === count &&
        group.filter((n) => n.isSeed).length === seedCount &&
        sameAmount(internal.get(cid) ?? 0, amount),
      `${context}: размер, seed или оборот не совпадает с графом`,
    );
    const topIds = text(row, 'top_gids', context).split(';');
    check(
      topIds.every((gid) => nodeMap.get(gid)?.cluster === cid),
      `${context}: ключевой узел из другого кластера`,
    );
    return {
      id: cid,
      count,
      seedCount,
      amount,
      topIds,
      hypothesis: text(row, 'hypothesis', context),
    };
  });
  keyed(rawTop, 'gid');
  const ranked = [...nodes].sort(
    (a, b) => b.priority - a.priority || (BigInt(a.id) < BigInt(b.id) ? -1 : 1),
  );
  const top = rawTop.rows.map((row, index) => {
    const context = `top_nodes.csv, строка ${index + 2}`,
      gid = id(row, 'gid', context),
      rank = integer(row, 'rank', context),
      node = nodeMap.get(gid);
    check(
      node &&
        rank === index + 1 &&
        ranked[index]?.id === gid &&
        text(row, 'role', context) === node.role &&
        Math.abs(num(row, 'priority_score', context, 1) - node.priority) < 1e-8,
      `${context}: топ не соответствует nodes_roles.csv`,
    );
    return { id: gid, rank, why: text(row, 'why', context) };
  });
  check(top.length > 0, 'top_nodes.csv: очередь проверки пуста');
  const dates = transactions.map((t) => t.date).sort();
  return {
    nodes,
    edges,
    clusters,
    transactions,
    top,
    totalAmount: edges.reduce((sum, e) => sum + e.amount, 0),
    period: dates.length
      ? { start: dates[0], end: dates[dates.length - 1] }
      : null,
  };
}
