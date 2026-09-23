# Граф денег

## Аналитика (`analysis/`)

Нужен Python 3.9+. Сеть, LLM и внешние данные не нужны.

Из корня репозитория:

```bash
python3 -m venv analysis/.venv
analysis/.venv/bin/python -m pip install -r analysis/requirements.txt
analysis/.venv/bin/python analysis/run.py
```

Расчёт занимает около 5 секунд. Скрипт читает Parquet из `docs/data/` и пишет CSV в `analysis/out/`:

| Файл | Что внутри |
|---|---|
| `nodes_roles.csv` | роли и приоритет всех клиентов |
| `top_nodes.csv` | топ-30 для проверки с объяснением |
| `clusters.csv` | кластеры и гипотезы по ним |
| `resilience.csv` | сценарии блокировки топ-N счетов |
| `data_requests.csv` | каких данных не хватает по узлам |
| `edges_flow.csv` | рёбра с долей денег seed |

Тесты:

```bash
analysis/.venv/bin/python -m unittest discover -s analysis/tests -v
```

Параметры, методика и описание колонок — в [analysis/README.md](analysis/README.md).
