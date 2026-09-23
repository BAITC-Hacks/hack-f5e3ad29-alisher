<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Контекст проекта HackAlem

- Соло-проект для трека «Финансы», кейс «Граф денег: восстановление финансовой структуры организованной группы по транзакционной сети». Репозиторий — источник истины: продукт — `docs/product.md`, решения — `docs/decisions.md`, архитектура — `docs/architecture.md`.
- `docs/hackathon.md` — справочник; не читай его по умолчанию, только для вопросов о правилах, кейсе, оценивании, сдаче или логистике.
- При содержательном изменении файлов в `docs/` обновляй отметку времени на актуальное время в формате `23 сентября 2026, 14:24 (UTC+5, Астана)`.
- Исходный датасет лежит в `docs/data/`, схема — в `docs/data/README.md`; стартовый код и его зависимости — в `docs/starter/`. Стартовый скрипт пишет только каркас CSV с пустыми ролями, кластерами и топом; не считай его готовым решением.
- За 5 часов важнее один надёжный end-to-end сценарий, чем широкий набор функций. Добавляй только то, что улучшает оценку или демо.
- Обязательный результат кейса: локальный воспроизводимый пересчёт трёх `.parquet` в `nodes_roles.csv`, `clusters.csv`, `top_nodes.csv` за 5 минут или быстрее, плюс экран с направлением потоков, ролями и поиском по `gid`.
- Для каждого узла нужны объяснимая роль, `role_score`, `priority_score`, кластер и непустое `evidence`. Выводы — гипотезы для проверки, не утверждения о виновности. Учитывай обрыв выборки на четвёртом колене и неполноту входящих потоков.
- Проект должен запускаться жюри по README без личных аккаунтов и платных сервисов; секреты — только в переменных окружения, не в Git. Не хардкодь ответы по `gid` и не выдумывай атрибуты клиентов.
