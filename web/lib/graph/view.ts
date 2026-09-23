import type { MoneyDataset, MoneyEdge, MoneyNode } from './types';

// A force layout over the entire registry delays the first useful frame.
export const MAX_GRAPH_NODES = 250;
export const MAX_GRAPH_EDGES = 700;

export interface GraphView {
  nodes: MoneyNode[];
  edges: MoneyEdge[];
}

export function getGraphView(
  dataset: MoneyDataset,
  cluster: string,
  selected: string | null,
  neighborsOnly: boolean,
): GraphView {
  const eligible = cluster
    ? dataset.nodes.filter((node) => node.cluster === cluster)
    : dataset.nodes;
  const eligibleIds = new Set(eligible.map((node) => node.id));
  const neighborAmounts = new Map<string, number>();
  if (selected && eligibleIds.has(selected)) {
    for (const edge of dataset.edges) {
      const neighbor =
        edge.source === selected
          ? edge.target
          : edge.target === selected
            ? edge.source
            : null;
      if (neighbor && eligibleIds.has(neighbor))
        neighborAmounts.set(neighbor, edge.amount);
    }
  }

  const candidates =
    neighborsOnly && selected && eligibleIds.has(selected)
      ? eligible.filter(
          (node) => node.id === selected || neighborAmounts.has(node.id),
        )
      : eligible;
  const nodes = [...candidates]
    .sort((a, b) => {
      if (selected) {
        if (a.id === selected) return -1;
        if (b.id === selected) return 1;
        const aAmount = neighborAmounts.get(a.id) ?? 0;
        const bAmount = neighborAmounts.get(b.id) ?? 0;
        if (aAmount !== bAmount) return bAmount - aAmount;
      }
      return b.priority - a.priority || a.id.localeCompare(b.id);
    })
    .slice(0, MAX_GRAPH_NODES);
  const ids = new Set(nodes.map((node) => node.id));
  const edges = dataset.edges
    .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
    .sort(
      (a, b) =>
        Number(b.source === selected || b.target === selected) -
          Number(a.source === selected || a.target === selected) ||
        b.amount - a.amount,
    )
    .slice(0, MAX_GRAPH_EDGES);
  return { nodes, edges };
}
