export type Status = 'todo' | 'in_progress' | 'review' | 'done';
export type Priority = 'low' | 'medium' | 'high';

export interface Task {
  id: number;
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

export interface Member { id: number; name: string; role: string; initials: string; color: string }
export interface Activity { id: number; text: string; name: string; initials: string; color: string; created_at: string }
export interface Dashboard {
  stats: { total: number; done: number; inProgress: number; review: number };
  projects: Project[];
  activity: Activity[];
}

