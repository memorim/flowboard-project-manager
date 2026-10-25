import { json, HttpError, type ReadScope } from './flow-http.js';
const join = `SELECT t.id,t.title,t.description,t.status,t.priority,t.project_id,t.assignee_id,t.due_date,t.version,t.deleted_at,p.name project_name,p.color project_color,m.name assignee_name,m.initials,m.color assignee_color FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN members m ON m.id=t.assignee_id`;

export async function workspaceReads({ req, db, workspace, space, role }: ReadScope) {
  const url = new URL(req.url),
    path = url.pathname,
    method = req.method;
  const q = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
  if (method === 'GET') {
    if (path === '/api/meta') {
      const [projects, members] = await db.batch([
        q('SELECT * FROM projects WHERE workspace_id=? ORDER BY name', workspace),
        q(
          'SELECT m.id,m.name,m.role,m.initials,m.color,ms.role access_role,(SELECT COUNT(*) FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.assignee_id=m.id AND p.workspace_id=ms.workspace_id AND t.deleted_at IS NULL) task_count FROM members m JOIN memberships ms ON ms.member_id=m.id WHERE ms.workspace_id=? ORDER BY name',
          workspace,
        ),
      ]);
      return json({ projects: projects.results, members: members.results });
    }
    if (path === '/api/tasks' || path === '/api/tasks/page' || path === '/api/tasks/trash') {
      const search = (url.searchParams.get('search') || '').trim().slice(0, 200),
        status = url.searchParams.get('status') || '',
        project = Number(url.searchParams.get('project') || 0),
        assignee = url.searchParams.get('assignee') || '';
      const limit = Number(url.searchParams.get('limit') || 40),
        offset = Number(url.searchParams.get('offset') || 0);
      if (
        !Number.isSafeInteger(project) ||
        project < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > 1000000 ||
        (status && !['todo', 'in_progress', 'review', 'done', 'all'].includes(status)) ||
        (assignee && assignee !== 'none' && !/^[1-9]\d*$/.test(assignee))
      )
        throw new HttpError(400, 'Некорректные параметры страницы');
      const clauses = [
          'p.workspace_id=?',
          path.endsWith('/trash') ? 't.deleted_at IS NOT NULL' : 't.deleted_at IS NULL',
        ],
        values: unknown[] = [workspace];
      if (search) {
        clauses.push('(t.title LIKE ? OR t.description LIKE ?)');
        values.push('%' + search + '%', '%' + search + '%');
      }
      if (status && status !== 'all') {
        clauses.push('t.status=?');
        values.push(status);
      }
      if (project) {
        clauses.push('t.project_id=?');
        values.push(project);
      }
      if (assignee) {
        clauses.push(assignee === 'none' ? 't.assignee_id IS NULL' : 't.assignee_id=?');
        if (assignee !== 'none') values.push(Number(assignee));
      }
      const where = ' WHERE ' + clauses.join(' AND '),
        [rows, count] = await db.batch([
          q(join + where + ' ORDER BY t.due_date,t.id LIMIT ? OFFSET ?', ...values, limit, offset),
          q(
            'SELECT COUNT(*) total FROM tasks t JOIN projects p ON p.id=t.project_id' + where,
            ...values,
          ),
        ]);
      return json(
        path.endsWith('/page') || path.endsWith('/trash')
          ? {
              items: rows.results,
              total: Number(count.results[0]?.total ?? 0),
              limit,
              offset,
            }
          : rows.results,
      );
    }
    if (path === '/api/dashboard') {
      const [stats, projects, activity] = await db.batch([
        q(
          `SELECT COUNT(*) total,COALESCE(SUM(t.status='done'),0) done,COALESCE(SUM(t.status='in_progress'),0) inProgress,COALESCE(SUM(t.status='review'),0) review FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.workspace_id=? AND t.deleted_at IS NULL`,
          workspace,
        ),
        q(
          `SELECT p.*,COUNT(t.id) task_count,COALESCE(SUM(t.status='done'),0) done_count,CASE WHEN COUNT(t.id)=0 THEN 0 ELSE ROUND(100.0*SUM(t.status='done')/COUNT(t.id)) END progress FROM projects p LEFT JOIN tasks t ON t.project_id=p.id AND t.deleted_at IS NULL WHERE p.workspace_id=? GROUP BY p.id ORDER BY p.due_date`,
          workspace,
        ),
        q(
          'SELECT a.*,m.name,m.initials,m.color FROM activity a JOIN members m ON m.id=a.member_id WHERE a.workspace_id=? ORDER BY a.id DESC LIMIT 20',
          workspace,
        ),
      ]);
      return json({
        stats: stats.results[0],
        projects: projects.results,
        activity: activity.results,
      });
    }
    const historyMatch = path.match(/^\/api\/tasks\/(\d+)\/history$/);
    if (historyMatch) {
      const id = Number(historyMatch[1]);
      if (
        !(await q(
          'SELECT t.id FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=? AND p.workspace_id=?',
          id,
          workspace,
        ).first())
      )
        throw new HttpError(404, 'Задача не найдена');
      const entries = (
        await q(
          'SELECT h.id,h.action,h.version,h.created_at,h.before_json,h.after_json,m.name actor_name FROM task_history h LEFT JOIN members m ON m.id=h.member_id WHERE h.task_id=? AND h.workspace_id=? ORDER BY h.version DESC LIMIT 100',
          id,
          workspace,
        ).all()
      ).results;
      return json(
        entries.map(({ before_json, after_json, ...h }) => ({
          ...h,
          before: before_json ? JSON.parse(String(before_json)) : null,
          after: JSON.parse(String(after_json)),
        })),
      );
    }
    if (path === '/api/export') {
      if (role !== 'owner') throw new HttpError(403, 'Экспорт доступен владельцу');
      const [projects, tasks, members] = await db.batch([
        q('SELECT * FROM projects WHERE workspace_id=?', workspace),
        q(join + ' WHERE p.workspace_id=?', workspace),
        q(
          'SELECT m.id,m.name,ms.role FROM members m JOIN memberships ms ON ms.member_id=m.id WHERE ms.workspace_id=?',
          workspace,
        ),
      ]);
      return json({
        format: 'flowboard-workspace-v1',
        exportedAt: new Date().toISOString(),
        workspace: { id: space.id, name: space.name },
        projects: projects.results,
        tasks: tasks.results,
        members: members.results,
      });
    }
  }
}
