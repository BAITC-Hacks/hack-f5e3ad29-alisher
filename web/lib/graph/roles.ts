import type { Role } from './types';

export const ROLE_STYLE: Record<
  Role,
  { label: string; color: string; shape: string; description: string }
> = {
  coordinator: {
    label: 'Координатор',
    color: '#c4a0ff',
    shape: 'hexagon',
    description: 'Входящее и исходящее ветвление, связь с несколькими seed',
  },
  distributor: {
    label: 'Распределитель',
    color: '#62b5ff',
    shape: 'triangle',
    description: 'Переводы многим получателям',
  },
  consolidator: {
    label: 'Консолидатор',
    color: '#ffc478',
    shape: 'square',
    description: 'Сбор переводов от нескольких отправителей',
  },
  transit: {
    label: 'Транзитный',
    color: '#52d8c1',
    shape: 'diamond',
    description: 'Сопоставимые наблюдаемые вход и выход',
  },
  terminal: {
    label: 'Малый выход',
    color: '#f792ae',
    shape: 'pentagon',
    description: 'Гипотеза малого выхода в периоде наблюдения',
  },
  peripheral: {
    label: 'Не определена',
    color: '#7b8ba4',
    shape: 'circle',
    description: 'Недостаточно признаков для специализированной роли',
  },
};

const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const currency = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat('ru-RU', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
export const formatNumber = (value: number) => number.format(value);
export const formatMoney = (value: number) => `${currency.format(value)} ₸`;
export const compactMoney = (value: number) => `${compact.format(value)} ₸`;
export const formatScore = (value: number) => value.toFixed(3);
export const shortId = (id: string) => `…${id.slice(-7)}`;
export function formatPeriod(period: { start: string; end: string } | null) {
  if (!period) return 'Нет транзакций';
  const format = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `${format.format(new Date(period.start))} — ${format.format(new Date(period.end))}`;
}
