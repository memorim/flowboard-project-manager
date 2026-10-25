import { DatabaseSync } from 'node:sqlite';
import {readFileSync} from 'node:fs';
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
  try{
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
  db.exec('BEGIN IMMEDIATE');
  db.exec(`
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
  db.exec(`CREATE TABLE IF NOT EXISTS workspaces(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,is_public INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS memberships(workspace_id INTEGER NOT NULL REFERENCES workspaces(id),member_id INTEGER NOT NULL REFERENCES members(id),role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),PRIMARY KEY(workspace_id,member_id));
    CREATE TABLE IF NOT EXISTS invitations(id INTEGER PRIMARY KEY AUTOINCREMENT,workspace_id INTEGER NOT NULL REFERENCES workspaces(id),token_hash TEXT NOT NULL UNIQUE,role TEXT NOT NULL CHECK(role IN ('editor','viewer')),expires_at TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES members(id),accepted_by INTEGER REFERENCES members(id));
    INSERT OR IGNORE INTO workspaces(id,name,is_public) VALUES (1,'Общее демо',1);`);
  for (const [table,column,definition] of [['projects','workspace_id','INTEGER NOT NULL DEFAULT 1'],['activity','workspace_id','INTEGER NOT NULL DEFAULT 1'],['tasks','version','INTEGER NOT NULL DEFAULT 1'],['tasks','deleted_at','TEXT'],['tasks','changed_by','INTEGER REFERENCES members(id)']]) {
    if (!(db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).some(c=>c.name===column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS projects_workspace ON projects(workspace_id); CREATE INDEX IF NOT EXISTS activity_workspace ON activity(workspace_id,id);');
  for(const column of ['request_key','request_payload','create_result']){
    if(!(db.prepare('PRAGMA table_info(tasks)').all() as {name:string}[]).some(c=>c.name===column))db.exec(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS tasks_request_key ON tasks(request_key)');
  db.exec('CREATE INDEX IF NOT EXISTS tasks_project_state_due ON tasks(project_id,status,due_date,id);CREATE INDEX IF NOT EXISTS tasks_project_due ON tasks(project_id,due_date,id);');
  db.exec(readFileSync(new URL('./task-history.sql',import.meta.url),'utf8'));
  const count = db.prepare('SELECT COUNT(*) AS count FROM members').get() as { count: number };
  if (count.count === 0) {
    db.exec(seedSql);
    for (const table of ['projects', 'tasks']) {
      for (const row of db.prepare(`SELECT id,due_date FROM ${table}`).all() as {id:number;due_date:string}[]) {
        const due = new Date(Date.now() + (new Date(row.due_date).getTime() - new Date('2026-07-04').getTime())).toISOString().slice(0,10);
        db.prepare(`UPDATE ${table} SET due_date=? WHERE id=?`).run(due,row.id);
      }
    }
    db.exec('DELETE FROM activity');
    db.prepare('INSERT INTO activity(text,member_id,created_at) VALUES (?,?,?)').run('подготовил(а) демонстрационное рабочее пространство',4,new Date().toISOString());
  }
  db.exec("INSERT OR IGNORE INTO memberships(workspace_id,member_id,role) SELECT 1,id,CASE WHEN id=4 THEN 'owner' ELSE 'editor' END FROM members");
  db.exec(readFileSync(new URL('./access-constraints.sql',import.meta.url),'utf8'));
  db.exec('COMMIT');return db;
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');db.close();throw error;}
}

