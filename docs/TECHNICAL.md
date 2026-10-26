> Historical notes from an earlier revision. For the current standalone authentication and migration procedure, see [Session model](SESSION_AUTH.md). Demo actor headers require explicit local demo mode.

# Три режима Flowboard

| Режим | Данные | Идентичность | Назначение |
|---|---|---|---|
| GitHub Pages | localStorage v2 | Переключение демо-участника | Индивидуальное знакомство без установки |
| Node / Express | SQLite data/flowboard.db | Доверенный X-Demo-Actor, без auth | Локальная разработка и тесты |
| Размещённое демо | Постоянная Cloudflare D1 | Аккаунт платформы | Общее демо и отдельные команды |

Локально: Node.js 24, pnpm 11; `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm start`. Адрес: http://localhost:4100. Для разработки `pnpm dev`.

GET /api/meta, /api/tasks, /api/dashboard, /api/session; POST /api/tasks; PATCH /api/tasks/:id для всех полей; PATCH /api/tasks/:id/status; DELETE /api/tasks/:id.

Редактирование принимает полный объект задачи. Zod проверяет enum, календарную дату и числовые ссылки; неизвестные поля отклоняются. Проект и назначенный участник должны существовать. Фильтры: project, status, search. Прогресс = done / total, пустой проект = 0%.

Браузерная версия переносит задачи из v1 в v2, не очищая старое хранилище; повреждённые данные не перезаписываются молча. При нехватке места интерфейс показывает ошибку.

Размещённая версия: D1 batch атомарно сохраняет задачу и активность; публичный API не раскрывает реальные имя/email вошедшего пользователя. Псевдоним строится по site-specific userId. Запись ограничена 16 KiB и 30 изменениями в минуту на участника (счётчик по журналу; это мягкий лимит, не глобальная квота при параллельных запросах).

Отдельные пространства ограничивают чтение и запись через memberships; owner управляет участниками, editor меняет задачи, viewer читает. version в UPDATE/DELETE предотвращает потерянное обновление: 409 при устаревшей форме. Realtime и полная история версий не реализованы. Старые демоданные на диске не заменяются при обновлении.


Командные endpoints: GET/POST /api/workspaces; POST /api/projects; POST /api/invitations {role}; POST /api/invitations/accept {token}; PATCH/DELETE /api/members/:id; GET /api/export. Выбранное пространство задаёт ?workspace=<id>. Запросы изменения задачи и статуса включают version; DELETE принимает {version}. Метаданные и связи проверяются внутри пространства. Приглашения одноразовые на 7 дней; в базе только SHA-256 токена.

## Текущий режим работы
Есть три варианта запуска. GitHub Pages хранит состояние в localStorage одного браузера. Node API использует доверенный X-Demo-Actor и требует защищающего шлюза для публичного доступа. Размещённая версия использует вход в аккаунт и D1, изменения доступны вошедшим участникам общего пространства. В локальном API есть отдельные пространства и роли. Обновление данных — после действия или по кнопке. Автоматические копии SQLite относятся только к работающему Node-серверу; D1 обслуживается отдельно.
