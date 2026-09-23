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
  LoaderCircle,
  X,
} from 'lucide-react';
import {
  ROLE_STYLE,
  formatMoney,
  formatNumber,
  formatPercent,
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
  const [brief, setBrief] = useState('');
  const [briefError, setBriefError] = useState('');
  const [briefLoading, setBriefLoading] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const briefRequest = useRef<AbortController | null>(null);
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
  useEffect(() => () => briefRequest.current?.abort(), []);
  async function generateBrief() {
    const controller = new AbortController();
    briefRequest.current = controller;
    setBriefLoading(true);
    setBriefError('');
    try {
      const response = await fetch('/api/node-brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: node.role,
          evidence: node.evidence,
          roleScore: node.roleScore,
          priority: node.priority,
          depth: node.depth,
          isSeed: node.isSeed,
          inAmount: node.inAmount,
          outAmount: node.outAmount,
          inDegree: node.inDegree,
          outDegree: node.outDegree,
          inTx: node.inTx,
          outTx: node.outTx,
          passThrough: node.passThrough,
          seedReach: node.seedReach,
        }),
        signal: controller.signal,
      });
      const result: { brief?: string; error?: string } = await response.json();
      if (!response.ok || !result.brief) {
        throw new Error(result.error || 'Не удалось сформировать бриф.');
      }
      setBrief(result.brief);
    } catch (error) {
      if (!controller.signal.aborted) {
        setBriefError(
          error instanceof Error
            ? error.message
            : 'Не удалось сформировать бриф.',
        );
      }
    } finally {
      if (!controller.signal.aborted) setBriefLoading(false);
    }
  }
  function toggleWhy() {
    if (!whyOpen && !brief && !briefLoading) void generateBrief();
    setWhyOpen((open) => !open);
  }
  const top = dataset.top.find((n) => n.id === node.id);
  const caveats = (
    <>
      {node.depth === 4 && (
        <p className="node-caveat">
          Граница выгрузки: дальнейшие переводы не видны. Отсутствие выхода не
          означает удержание денег.
        </p>
      )}
      {node.isSeed && (
        <p className="node-caveat">
          У исходного узла входящие переводы неполны. Наблюдаемые суммы не
          являются балансом счёта.
        </p>
      )}
    </>
  );
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
        <div className="node-role-copy">
          <h2 id="node-card-title">{ROLE_STYLE[node.role].label}</h2>
          <div className="node-role-meta">
            <span className="muted">Гипотеза роли</span>
            {top && <span className="rank-badge">Топ {top.rank}</span>}
          </div>
        </div>
        <button
          className="node-why-button"
          type="button"
          aria-expanded={whyOpen}
          aria-controls="node-role-explanation"
          onClick={toggleWhy}
        >
          Почему?
        </button>
      </div>
      <div
        className="node-evidence"
        id="node-role-explanation"
        role="region"
        aria-label="Объяснение роли"
        hidden={!whyOpen}
      >
        {briefLoading ? (
          <p className="node-brief-loading" role="status">
            <LoaderCircle size={14} className="node-brief-spinner" />
            Формируем объяснение…
          </p>
        ) : brief ? (
          <p className="node-brief-result">{brief}</p>
        ) : null}
        {briefError && (
          <div className="node-brief-failure">
            <p className="node-brief-error" role="alert">
              {briefError}
            </p>
            <button type="button" onClick={generateBrief}>
              Повторить
            </button>
          </div>
        )}
        <details className="node-explanation">
          <summary>Исходные признаки</summary>
          <ul className="node-source-list">
            <li>
              Получено: {formatMoney(node.inAmount)}. Отправителей:{' '}
              {formatNumber(node.inDegree)}; входящих переводов:{' '}
              {formatNumber(node.inTx)}.
            </li>
            <li>
              Отправлено: {formatMoney(node.outAmount)}. Получателей:{' '}
              {formatNumber(node.outDegree)}; исходящих переводов:{' '}
              {formatNumber(node.outTx)}.
            </li>
            {node.passThrough !== null && (
              <li>
                Исходящая сумма составляет {formatPercent(node.passThrough)} от
                наблюдаемой входящей суммы.
              </li>
            )}
            <li>
              Связи с исходными узлами: {formatNumber(node.seedReach)}.
              {node.isSeed
                ? ' Узел сам входит в исходный список.'
                : ` Число переходов от исходного узла: ${node.depth}.`}
            </li>
          </ul>
          {caveats}
        </details>
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
        {node.isSeed && <span className="seed-tag">Исходный</span>}
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
          <dt>Связи с исходными узлами</dt>
          <dd>{node.seedReach}</dd>
        </div>
      </dl>
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
