-- Recheck write access inside the same SQLite/D1 statement as the mutation.
-- changed_by is provided by the trusted API identity adapter; NULL is reserved
-- for migrations and fixtures, not accepted from a task request body.
CREATE TRIGGER IF NOT EXISTS task_access_insert BEFORE INSERT ON tasks
WHEN NEW.changed_by IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id
 WHERE p.id=NEW.project_id AND m.member_id=NEW.changed_by AND m.role IN ('owner','editor')
)
BEGIN SELECT RAISE(ABORT,'flow_access_denied'); END;
CREATE TRIGGER IF NOT EXISTS task_access_update BEFORE UPDATE ON tasks
WHEN NEW.changed_by IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id
 WHERE p.id=NEW.project_id AND m.member_id=NEW.changed_by AND m.role IN ('owner','editor')
)
BEGIN SELECT RAISE(ABORT,'flow_access_denied'); END;
CREATE TRIGGER IF NOT EXISTS task_assignee_insert BEFORE INSERT ON tasks
WHEN NEW.assignee_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id
 WHERE p.id=NEW.project_id AND m.member_id=NEW.assignee_id
)
BEGIN SELECT RAISE(ABORT,'flow_assignee_missing'); END;
CREATE TRIGGER IF NOT EXISTS task_assignee_update BEFORE UPDATE OF project_id,assignee_id ON tasks
WHEN NEW.assignee_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id
 WHERE p.id=NEW.project_id AND m.member_id=NEW.assignee_id
)
BEGIN SELECT RAISE(ABORT,'flow_assignee_missing'); END;
CREATE TRIGGER IF NOT EXISTS invitation_owner_insert BEFORE INSERT ON invitations
WHEN NOT EXISTS (
 SELECT 1 FROM memberships WHERE workspace_id=NEW.workspace_id
 AND member_id=NEW.created_by AND role='owner'
)
BEGIN SELECT RAISE(ABORT,'flow_access_denied'); END;
