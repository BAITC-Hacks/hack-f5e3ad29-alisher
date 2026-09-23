'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  Copy,
  Expand,
  GitBranch,
  Layers3,
  X,
} from 'lucide-react';
import {
  ROLE_STYLE,
  formatMoney,
  formatNumber,
  formatScore,
} from '@/lib/graph/roles';
import type { MoneyDataset, MoneyNode } from '@/lib/graph/types';
import { RoleSymbol } from './role-symbol';

export function NodeCard({
  node,
  dataset,
  onClose,
  onNeighbors,
  onCluster,
}: {
  node: MoneyNode;
  dataset: MoneyDataset;
  onClose: () => void;
  onNeighbors: () => void;
  onCluster: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement;
    closeRef.current?.focus({ preventScroll: true });
    return () => previousFocus.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [onClose]);
  const cluster = dataset.clusters.find((c) => c.id === node.cluster);
  const top = dataset.top.find((n) => n.id === node.id);
  return (
    <section
      className="node-popover"
      role="dialog"
      aria-modal="false"
      aria-labelledby="node-card-title"
    >
      <div className="node-card-heading">
        <span className="eyebrow">Карточка узла</span>
        <button
          ref={closeRef}
          className="icon-button"
          onClick={onClose}
          aria-label="Закрыть карточку"
        >
          <X size={17} />
        </button>
      </div>
      <div className="node-identity">
        <RoleSymbol role={node.role} seed={node.isSeed} large />
        <div>
          <h2 id="node-card-title">{ROLE_STYLE[node.role].label}</h2>
          <span className="muted">Гипотеза роли</span>
        </div>
        {top && <span className="rank-badge">Топ {top.rank}</span>}
      </div>
      <div className="node-id">
        <code>{node.id}</code>
        <button
          className="icon-button"
          aria-label="Скопировать gid"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(node.id);
              setCopied(true);
              setCopyError(false);
            } catch {
              setCopyError(true);
            }
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      {copyError && (
        <p className="muted" role="status">
          Выделите и скопируйте gid выше.
        </p>
      )}
      <div className="node-tags">
        <span>Кластер #{node.cluster}</span>
        <span>Глубина {node.depth}</span>
        {node.isSeed && <span className="seed-tag">Seed</span>}
      </div>
      <div className="node-score">
        <div>
          <span>Приоритет проверки</span>
          <strong>{formatScore(node.priority)}</strong>
        </div>
        <div className="score-track">
          <span
            style={{
              width: `${node.priority * 100}%`,
              background: ROLE_STYLE[node.role].color,
            }}
          />
        </div>
        <small>Поддержка гипотезы: {node.roleScore.toFixed(2)} из 1</small>
      </div>
      <div className="flow-metrics">
        <div>
          <span>
            <ArrowDownLeft size={14} /> Вход
          </span>
          <strong>{formatMoney(node.inAmount)}</strong>
          <small>
            {formatNumber(node.inDegree)} отправителей ·{' '}
            {formatNumber(node.inTx)} переводов
          </small>
        </div>
        <div>
          <span>
            <ArrowUpRight size={14} /> Выход
          </span>
          <strong>{formatMoney(node.outAmount)}</strong>
          <small>
            {formatNumber(node.outDegree)} получателей ·{' '}
            {formatNumber(node.outTx)} переводов
          </small>
        </div>
      </div>
      <dl className="node-facts">
        <div>
          <dt>Выход / вход</dt>
          <dd>
            {node.passThrough === null
              ? 'Не определено'
              : node.passThrough.toFixed(3)}
          </dd>
        </div>
        <div>
          <dt>Достижим от seed</dt>
          <dd>{node.seedReach}</dd>
        </div>
      </dl>
      <div className="node-evidence">
        <h3>Почему эта роль</h3>
        <p>{node.evidence}</p>
      </div>
      {node.depth === 4 && (
        <p className="node-caveat">
          Граница выгрузки: дальнейшие переводы не видны. Отсутствие выхода не
          означает удержание денег.
        </p>
      )}
      {node.isSeed && (
        <p className="node-caveat">
          У исходного seed входящие переводы неполны. Наблюдаемые суммы не
          являются балансом счёта.
        </p>
      )}
      {top && (
        <details className="node-explanation">
          <summary>Объяснение места в топе</summary>
          <p>{top.why}</p>
        </details>
      )}
      {cluster && (
        <details className="node-explanation">
          <summary>
            Кластер #{cluster.id} · {cluster.count} узлов
          </summary>
          <p>{cluster.hypothesis}</p>
          <p>Внутренний оборот: {formatMoney(cluster.amount)}</p>
        </details>
      )}
      <div className="node-card-actions">
        <button onClick={onNeighbors}>
          <GitBranch size={15} /> Окружение
        </button>
        <button onClick={onCluster}>
          <Layers3 size={15} /> Весь кластер
        </button>
      </div>
      <p className="node-footnote">
        <Expand size={12} /> Выводы относятся к полному периоду набора.
      </p>
    </section>
  );
}
