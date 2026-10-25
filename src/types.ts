export type Status = 'todo' | 'in_progress' | 'review' | 'done';
export type Priority = 'low' | 'medium' | 'high';

export interface Task {
  id: number;
  version: number;
  deleted_at?: string | null;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  project_id: number;
  project_name: string;
  project_color: string;
  assignee_id: number | null;
  assignee_name: string | null;
  initials: string | null;
  assignee_color: string | null;
  due_date: string;
}

export interface Project {
  id: number;
  name: string;
  client: string;
  color: string;
  progress: number;
  due_date: string;
  task_count: number;
  done_count: number;
}

export interface Member {
  id: number;
  name: string;
  role: string;
  initials: string;
  color: string;
  access_role?: string;
  task_count?: number;
}
export interface Activity {
  id: number;
  text: string;
  name: string;
  initials: string;
  color: string;
  created_at: string;
}
export interface Dashboard {
  stats: { total: number; done: number; inProgress: number; review: number };
  projects: Project[];
  activity: Activity[];
}

export interface Workspace {
  id: number;
  name: string;
  is_public: number;
  access_role: string;
}
export interface Session {
  mode: string;
  user: Member | null;
  workspace: Workspace;
  canWrite: boolean;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
export interface TaskFilters {
  search?: string;
  status?: string;
  project?: string;
  assignee?: string;
  limit?: number;
  offset?: number;
}

export interface HistoryEntry {
  id: number;
  action: string;
  version: number;
  created_at: string;
  actor_name: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
}
