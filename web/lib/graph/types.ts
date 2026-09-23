export const ROLES = [
  'coordinator',
  'distributor',
  'consolidator',
  'transit',
  'terminal',
  'peripheral',
] as const;
export type Role = (typeof ROLES)[number];

export interface MoneyNode {
  id: string;
  role: Role;
  roleScore: number;
  priority: number;
  cluster: string;
  evidence: string;
  depth: number;
  isSeed: boolean;
  inAmount: number;
  outAmount: number;
  inDegree: number;
  outDegree: number;
  inTx: number;
  outTx: number;
  passThrough: number | null;
  seedSources: number;
}

export interface MoneyEdge {
  id: string;
  source: string;
  target: string;
  amount: number;
  count: number;
}

export interface MoneyCluster {
  id: string;
  count: number;
  seedCount: number;
  amount: number;
  topIds: string[];
  hypothesis: string;
}

export interface MoneyTransaction {
  source: string;
  target: string;
  amount: number;
  date: string;
}

export interface MoneyDataset {
  nodes: MoneyNode[];
  edges: MoneyEdge[];
  clusters: MoneyCluster[];
  transactions: MoneyTransaction[];
  top: { id: string; rank: number; why: string }[];
  totalAmount: number;
  period: { start: string; end: string } | null;
}

export const DATA_FILES = [
  'nodes.parquet',
  'edges.parquet',
  'transactions.parquet',
  'nodes_roles.csv',
  'clusters.csv',
  'top_nodes.csv',
] as const;
export type DataFileName = (typeof DATA_FILES)[number];
export type DatasetBytes = Record<DataFileName, ArrayBuffer>;

export type WorkerReply =
  | { type: 'progress'; message: string }
  | { type: 'success'; dataset: MoneyDataset }
  | { type: 'error'; message: string };
