import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type Db = DatabaseSync;

const seedSql = `
  INSERT INTO members (id, name, role, initials, color) VALUES
    (1, 'Анна Морозова', 'Product designer', 'АМ', '#ff8f66'),
    (2, 'Илья Власов', 'Frontend developer', 'ИВ', '#b9a7ff'),
    (3, 'Марк Левин', 'Backend developer', 'МЛ', '#8ed8b5'),
    (4, 'Саша Ким', 'Product manager', 'СК', '#f4ca64');

  INSERT INTO projects (id, name, client, color, progress, due_date) VALUES
    (1, 'Nova Mobile', 'Nova Bank', '#ff6b3d', 68, '2026-07-18'),
    (2, 'Care Dashboard', 'Medline', '#7c64e3', 42, '2026-08-02'),
    (3, 'Merchant Portal', 'Vektor', '#32a875', 84, '2026-07-11');

  INSERT INTO tasks (id, title, description, status, priority, project_id, assignee_id, due_date) VALUES
    (1, 'Собрать состояния онбординга', 'Пустые, загрузочные и ошибочные состояния для первого запуска', 'in_progress', 'high', 1, 1, '2026-07-07'),
    (2, 'Подключить биометрию', 'Face ID и fallback на короткий код', 'review', 'high', 1, 2, '2026-07-06'),
    (3, 'Оптимизировать ленту операций', 'Виртуализация списка и серверная пагинация', 'todo', 'medium', 1, 3, '2026-07-12'),
    (4, 'Экспорт отчёта в PDF', 'Шаблон ежемесячной выгрузки для клиник', 'in_progress', 'medium', 2, 3, '2026-07-16'),
    (5, 'Проверить контрастность графиков', 'WCAG AA для всех цветовых серий', 'todo', 'low', 2, 1, '2026-07-20'),
    (6, 'Настроить роли сотрудников', 'Владелец, администратор, кассир и наблюдатель', 'done', 'high', 3, 4, '2026-07-02'),
    (7, 'Обновить webhook-документацию', 'Примеры payload и таблица кодов ошибок', 'review', 'medium', 3, 3, '2026-07-08'),
    (8, 'Сценарий возврата платежа', 'Подтверждение и итоговый статус операции', 'todo', 'high', 3, 2, '2026-07-10');

  INSERT INTO activity (text, member_id, created_at) VALUES
    ('переместила «Собрать состояния онбординга» в работу', 1, '2026-07-04T09:42:00'),
    ('отправил «Подключить биометрию» на проверку', 2, '2026-07-04T08:16:00'),
    ('завершила настройку ролей сотрудников', 4, '2026-07-03T17:28:00'),
    ('добавил описание к экспорту отчёта', 3, '2026-07-03T15:03:00');
`;

export function createDatabase(filename = resolve('data', 'flowboard.db')) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
      initials TEXT NOT NULL, color TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, client TEXT NOT NULL,
      color TEXT NOT NULL, progress INTEGER NOT NULL, due_date TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('todo','in_progress','review','done')),
      priority TEXT NOT NULL CHECK(priority IN ('low','medium','high')),
      project_id INTEGER NOT NULL REFERENCES projects(id),
      assignee_id INTEGER REFERENCES members(id), due_date TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL,
      member_id INTEGER NOT NULL REFERENCES members(id), created_at TEXT NOT NULL
    );
  `);
  const count = db.prepare('SELECT COUNT(*) AS count FROM members').get() as { count: number };
  if (count.count === 0) db.exec(seedSql);
  return db;
}

