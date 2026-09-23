'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronDown,
  CircleHelp,
  CircleX,
  FileUp,
  Focus,
  GitBranch,
  Layers3,
  LoaderCircle,
  Minus,
  Network as NetworkIcon,
  Plus,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import {
  compactMoney,
  formatNumber,
  formatPeriod,
  formatScore,
  ROLE_STYLE,
} from '@/lib/graph/roles';
import {
  ROLES,
  type MoneyDataset,
  type MoneyNode,
  type WorkerReply,
} from '@/lib/graph/types';
import { getGraphView } from '@/lib/graph/view';
import type { NetworkHandle } from './network';
import { RoleSymbol } from './role-symbol';
import { NodeCard } from './node-card';
import { UploadDialog } from './upload-dialog';
import '@/app/graph.css';

const Network = dynamic(() => import('./network').then((m) => m.Network), {
  ssr: false,
  loading: () => (
    <div className="graph-empty">
      <LoaderCircle className="spin" size={24} />
      <p>Подготавливаем граф…</p>
    </div>
  ),
});

export function MoneyGraph() {
  const [dataset, setDataset] = useState<MoneyDataset | null>(null);
  const [loading, setLoading] = useState<string | null>(
    'Загружаем демонстрационный набор…',
  );
  const [error, setError] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [source, setSource] = useState('Демо');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [cluster, setCluster] = useState('');
  const [neighborsOnly, setNeighborsOnly] = useState(false);
  const [focusToken, setFocusToken] = useState(0);
  const [legendOpen, setLegendOpen] = useState(true);
  const workerRef = useRef<Worker | null>(null);
  const graphRef = useRef<NetworkHandle>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const openDataset = useCallback((files?: File[]) => {
    workerRef.current?.terminate();
    const worker = new Worker(
      new URL('../../lib/graph/dataset.worker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;
    worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
      if (workerRef.current !== worker) return;
      if (data.type === 'progress') setLoading(data.message);
      else if (data.type === 'error') {
        setLoading(null);
        setError(data.message);
        worker.terminate();
      } else {
        setDataset(data.dataset);
        setSource(files ? 'Свой набор' : 'Демо');
        setLoading(null);
        setError(null);
        setUploadOpen(false);
        setSelected(null);
        setCluster('');
        setNeighborsOnly(false);
        setQuery('');
        setFocusToken(0);
        worker.terminate();
      }
    };
    worker.onerror = () => {
      setLoading(null);
      setError(
        'Не удалось прочитать данные. Попробуйте открыть набор ещё раз.',
      );
      worker.terminate();
    };
    worker.postMessage({ files });
  }, []);
  useEffect(() => {
    openDataset();
    return () => workerRef.current?.terminate();
  }, [openDataset]);
  function load(files?: File[]) {
    setError(null);
    setLoading('Открываем данные…');
    openDataset(files);
  }
  function closeUpload() {
    if (loading) {
      workerRef.current?.terminate();
      setLoading(null);
    }
    setUploadOpen(false);
    setError(null);
  }

  const nodeMap = useMemo(
    () => new Map(dataset?.nodes.map((n) => [n.id, n]) ?? []),
    [dataset],
  );
  const topRanks = useMemo(
    () => new Map(dataset?.top.map((t) => [t.id, t.rank]) ?? []),
    [dataset],
  );
  const search = query.replace(/\s/g, '');
  const listed = useMemo(() => {
    if (!dataset) return [];
    if (!search) return dataset.top.map((t) => nodeMap.get(t.id)!);
    return dataset.nodes
      .filter((n) => n.id.includes(search))
      .sort(
        (a, b) =>
          Number(b.id === search) - Number(a.id === search) ||
          b.priority - a.priority,
      );
  }, [dataset, search, nodeMap]);
  const activeNode = selected ? nodeMap.get(selected) : null;
  const roleCounts = useMemo(() => {
    const result = new Map(ROLES.map((r) => [r, 0]));
    dataset?.nodes.forEach((n) => result.set(n.role, result.get(n.role)! + 1));
    return result;
  }, [dataset]);
  const seedCount = dataset?.nodes.filter((n) => n.isSeed).length ?? 0;
  const graphView = useMemo(
    () => dataset && getGraphView(dataset, cluster, selected, neighborsOnly),
    [dataset, cluster, selected, neighborsOnly],
  );
  function selectNode(node: MoneyNode, focus = true) {
    if (cluster && cluster !== node.cluster) setCluster('');
    setSelected(node.id);
    if (focus) setFocusToken((t) => t + 1);
  }
  const closeNode = useCallback(() => {
    setSelected(null);
    setNeighborsOnly(false);
  }, []);
  function resetView() {
    setCluster('');
    setNeighborsOnly(false);
    setSelected(null);
    setFocusToken(0);
    graphRef.current?.fit();
  }

  return (
    <main className="money-app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">
            <NetworkIcon size={24} strokeWidth={1.5} />
          </span>
          <div>
            <h1>
              Граф денег<span className="brand-dot">.</span>
            </h1>
            <span>Анализ связей и денежных потоков</span>
          </div>
        </div>
        <div className="dataset-context">
          <span className="dataset-badge">
            <span />
            {source}
          </span>
          <span className="dataset-period">
            {dataset ? formatPeriod(dataset.period) : 'Подготовка данных'}
          </span>
        </div>
        <div className="header-actions">
          {source !== 'Демо' && (
            <button
              className="quiet-button"
              onClick={() => load()}
              disabled={!!loading}
            >
              <RotateCcw size={15} /> Демо
            </button>
          )}
          <button
            className="primary-button"
            onClick={() => {
              setError(null);
              setUploadOpen(true);
            }}
            disabled={!!loading}
          >
            <FileUp size={16} /> Открыть данные
          </button>
        </div>
      </header>

      <div className="app-workspace">
        <aside className="node-sidebar" aria-label="Поиск и очередь проверки">
          <div className="sidebar-heading">
            <div>
              <span className="eyebrow">С чего начать</span>
              <h2>Очередь проверки</h2>
            </div>
            <span className="count-badge">{dataset?.top.length ?? '—'}</span>
          </div>
          <form
            className="node-search"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              if (listed[0]) selectNode(listed[0]);
            }}
          >
            <Search size={16} />
            <input
              ref={inputRef}
              type="search"
              placeholder="Найти узел по gid"
              aria-label="Найти узел по gid"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            {query && (
              <button
                type="button"
                aria-label="Очистить поиск"
                onClick={() => {
                  setQuery('');
                  inputRef.current?.focus();
                }}
              >
                <X size={14} />
              </button>
            )}
          </form>
          <div className="list-label">
            <span aria-live="polite">
              {search
                ? `Найдено: ${formatNumber(listed.length)}`
                : 'Топ по приоритету'}
            </span>
            <span>{search ? 'Весь реестр' : 'Приоритет ↓'}</span>
          </div>
          <div className="node-list">
            {!dataset && loading && (
              <div className="sidebar-loading">
                <LoaderCircle className="spin" size={18} />
                <span>Читаем набор данных</span>
              </div>
            )}
            {dataset && !listed.length && (
              <div className="search-empty">
                <Search size={25} />
                <strong>Узел не найден</strong>
                <p>
                  Проверьте gid или введите часть номера. Поиск охватывает все{' '}
                  {formatNumber(dataset.nodes.length)} узлов.
                </p>
              </div>
            )}
            {listed.slice(0, 100).map((node) => (
              <button
                className={`node-list-item ${selected === node.id ? 'is-selected' : ''}`}
                key={node.id}
                aria-pressed={selected === node.id}
                onClick={() => selectNode(node)}
              >
                <div className="node-list-main">
                  <span className="list-rank">
                    {topRanks.has(node.id)
                      ? String(topRanks.get(node.id)).padStart(2, '0')
                      : '—'}
                  </span>
                  <RoleSymbol role={node.role} seed={node.isSeed} />
                  <div className="list-node-text">
                    <code>{node.id}</code>
                    <span>{ROLE_STYLE[node.role].label}</span>
                  </div>
                  <span className="list-score">
                    {formatScore(node.priority)}
                  </span>
                </div>
                <div className="node-list-sub">
                  <span>
                    <ArrowDownLeft size={12} />
                    {compactMoney(node.inAmount)}
                  </span>
                  <span>
                    <ArrowUpRight size={12} />
                    {compactMoney(node.outAmount)}
                  </span>
                  <span className="list-cluster">#{node.cluster}</span>
                </div>
              </button>
            ))}
            {listed.length > 100 && (
              <p className="list-more">Показаны первые 100. Уточните gid.</p>
            )}
          </div>
          <div className="sidebar-note">
            <CircleHelp size={16} />
            <p>
              Приоритет задаёт порядок проверки.
              <br />
              Роль — объяснимая гипотеза.
            </p>
          </div>
        </aside>

        <section
          className="graph-stage"
          aria-label="Кластеризованный граф переводов"
        >
          <div className="graph-toolbar">
            <div className="graph-title">
              <span className="live-dot" />
              <h2>Карта связей</h2>
              <span className="graph-mode">2D</span>
            </div>
            <div className="graph-filters">
              <label className="cluster-picker">
                <Layers3 size={15} />
                <select
                  aria-label="Кластер на графе"
                  value={cluster}
                  disabled={!dataset}
                  onChange={(e) => {
                    setCluster(e.target.value);
                    setNeighborsOnly(false);
                    setSelected(null);
                    setFocusToken(0);
                  }}
                >
                  <option value="">Все кластеры</option>
                  {dataset?.clusters.map((c) => (
                    <option key={c.id} value={c.id}>
                      Кластер #{c.id} · {c.count} узлов
                    </option>
                  ))}
                </select>
                <ChevronDown size={13} />
              </label>
              {(cluster || neighborsOnly) && (
                <button className="quiet-button" onClick={resetView}>
                  <RotateCcw size={14} /> Сбросить
                </button>
              )}
            </div>
          </div>
          {dataset && graphView && (
            <div className="graph-summary">
              <span>
                <strong>{formatNumber(graphView.nodes.length)}</strong>
                {` из ${formatNumber(dataset.nodes.length)} узлов на карте`}
              </span>
              <span>
                <strong>{formatNumber(graphView.edges.length)}</strong> связей
                на карте
              </span>
              <span>
                <strong>{dataset.clusters.length}</strong> кластеров
              </span>
              <span>
                <strong>{seedCount}</strong> seed
              </span>
            </div>
          )}
          {neighborsOnly && activeNode && (
            <div className="scope-label">
              <GitBranch size={14} /> Окружение …{activeNode.id.slice(-7)}
              <button
                aria-label="Показать весь граф"
                onClick={() => setNeighborsOnly(false)}
              >
                <X size={13} />
              </button>
            </div>
          )}
          <div className="graph-canvas" data-testid="graph-canvas">
            {dataset && graphView && (
              <Network
                key={source + dataset.totalAmount + dataset.nodes.length}
                ref={graphRef}
                view={graphView}
                selected={selected}
                focusToken={focusToken}
                onSelect={(id) => {
                  if (id) {
                    const n = nodeMap.get(id);
                    if (n) selectNode(n, false);
                  } else closeNode();
                }}
              />
            )}
          </div>
          {!dataset && loading && (
            <div className="graph-empty">
              <div className="loading-orbit">
                <NetworkIcon size={30} />
              </div>
              <strong>{loading}</strong>
              <span>Parquet + результаты анализа</span>
            </div>
          )}
          {error && !uploadOpen && (
            <div className="graph-error" role="alert">
              <CircleX size={25} />
              <h2>Набор не открылся</h2>
              <p>{error}</p>
              <div>
                <button className="primary-button" onClick={() => load()}>
                  <RotateCcw size={15} /> Повторить
                </button>
                <button
                  onClick={() => {
                    setError(null);
                    setUploadOpen(true);
                  }}
                >
                  Выбрать файлы
                </button>
              </div>
            </div>
          )}
          {dataset && loading && !uploadOpen && (
            <div className="graph-loading-banner" role="status">
              <LoaderCircle className="spin" size={15} />
              {loading}
            </div>
          )}
          {dataset && (
            <>
              <div
                className={`graph-legend ${legendOpen ? '' : 'is-collapsed'}`}
              >
                <button
                  className="legend-heading"
                  aria-expanded={legendOpen}
                  onClick={() => setLegendOpen((v) => !v)}
                >
                  <span>Легенда</span>
                  <ChevronDown size={14} />
                </button>
                {legendOpen && (
                  <>
                    <div className="legend-roles">
                      {ROLES.map((role) => (
                        <div key={role}>
                          <RoleSymbol role={role} />
                          <span>{ROLE_STYLE[role].label}</span>
                          <span className="legend-count">
                            {roleCounts.get(role)}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="legend-semantics">
                      <div>
                        <span className="legend-sizes">
                          <i />
                          <i />
                          <i />
                        </span>
                        <span>Размер — приоритет</span>
                      </div>
                      <div>
                        <span className="legend-seed" />
                        <span>Кольцо — seed</span>
                      </div>
                      <div>
                        <span className="legend-edge">⟶</span>
                        <span>Стрелка — перевод</span>
                      </div>
                      <div>
                        <span className="legend-cluster" />
                        <span>Область — кластер</span>
                      </div>
                    </div>
                  </>
                )}
              </div>
              <div className="graph-controls">
                <button
                  aria-label="Приблизить граф"
                  onClick={() => graphRef.current?.zoomIn()}
                >
                  <Plus size={19} />
                </button>
                <button
                  aria-label="Отдалить граф"
                  onClick={() => graphRef.current?.zoomOut()}
                >
                  <Minus size={19} />
                </button>
                <span />
                <button
                  aria-label="Вписать граф в экран"
                  onClick={() => graphRef.current?.fit()}
                >
                  <Focus size={19} />
                </button>
              </div>
              <div className="graph-hint">
                Колесо — масштаб · перетаскивание — перемещение · клик — детали
              </div>
            </>
          )}
          {dataset && activeNode && (
            <NodeCard
              key={activeNode.id}
              node={activeNode}
              dataset={dataset}
              onClose={closeNode}
              onNeighbors={() => {
                setCluster('');
                setNeighborsOnly(true);
                setFocusToken((t) => t + 1);
              }}
              onCluster={() => {
                setCluster(activeNode.cluster);
                setNeighborsOnly(false);
                setFocusToken((t) => t + 1);
              }}
            />
          )}
        </section>
      </div>
      <footer className="app-footer">
        <span>
          <span className="status-dot" />
          {dataset ? `${source} · данные проверены` : 'Подключение набора'}
        </span>
        <span>
          Роли и приоритеты — гипотезы для проверки, не вероятность нарушения.
        </span>
      </footer>
      {uploadOpen && (
        <UploadDialog
          loading={loading}
          error={error}
          onLoad={(files) => load(files)}
          onClose={closeUpload}
        />
      )}
    </main>
  );
}
