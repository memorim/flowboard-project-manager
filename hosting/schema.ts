import {
  sqliteTable,
  integer,
  text,
  primaryKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
export const members = sqliteTable('members', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  role: text('role').notNull(),
  initials: text('initials').notNull(),
  color: text('color').notNull(),
  siteKey: text('site_key').unique(),
});
export const projects = sqliteTable(
  'projects',
  {
    id: integer('id').primaryKey(),
    name: text('name').notNull(),
    client: text('client').notNull(),
    color: text('color').notNull(),
    dueDate: text('due_date').notNull(),
    progress: integer('progress').notNull().default(0),
    workspaceId: integer('workspace_id').notNull().default(1),
  },
  (t) => [index('projects_workspace').on(t.workspaceId)],
);
export const tasks = sqliteTable(
  'tasks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
    description: text('description').notNull(),
    status: text('status').notNull(),
    priority: text('priority').notNull(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    assigneeId: integer('assignee_id').references(() => members.id),
    dueDate: text('due_date').notNull(),
    version: integer('version').notNull().default(1),
    requestKey: text('request_key').unique(),
    requestPayload: text('request_payload'),
    createResult: text('create_result'),
    deletedAt: text('deleted_at'),
    changedBy: integer('changed_by').references(() => members.id),
  },
  (t) => [
    index('tasks_project_state_due').on(t.projectId, t.status, t.dueDate, t.id),
    index('tasks_project_due').on(t.projectId, t.dueDate, t.id),
  ],
);
export const activity = sqliteTable(
  'activity',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    text: text('text').notNull(),
    memberId: integer('member_id')
      .notNull()
      .references(() => members.id),
    createdAt: text('created_at').notNull(),
    workspaceId: integer('workspace_id').notNull().default(1),
  },
  (t) => [index('activity_workspace').on(t.workspaceId, t.id)],
);

export const workspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  isPublic: integer('is_public').notNull().default(0),
});
export const memberships = sqliteTable(
  'memberships',
  {
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    memberId: integer('member_id')
      .notNull()
      .references(() => members.id),
    role: text('role', { enum: ['owner', 'editor', 'viewer'] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.memberId] })],
);
export const invitations = sqliteTable('invitations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  tokenHash: text('token_hash').notNull().unique(),
  role: text('role', { enum: ['editor', 'viewer'] }).notNull(),
  expiresAt: text('expires_at').notNull(),
  createdBy: integer('created_by')
    .notNull()
    .references(() => members.id),
  acceptedBy: integer('accepted_by').references(() => members.id),
});

export const seatlyProfiles = sqliteTable('seatly_profiles', {
  sandboxKey: text('sandbox_key').primaryKey(),
  role: text('role', { enum: ['guest', 'owner', 'none'] })
    .notNull()
    .default('guest'),
});
export const seatlyBookings = sqliteTable(
  'seatly_bookings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sandboxKey: text('sandbox_key')
      .notNull()
      .references(() => seatlyProfiles.sandboxKey),
    spaceId: integer('space_id').notNull(),
    guestName: text('guest_name').notNull(),
    guestEmail: text('guest_email').notNull(),
    bookingDate: text('booking_date').notNull(),
    startTime: text('start_time').notNull(),
    endTime: text('end_time').notNull(),
    guests: integer('guests').notNull(),
    totalPrice: integer('total_price').notNull(),
    status: text('status').notNull(),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull(),
    requestKey: text('request_key').unique(),
    requestPayload: text('request_payload'),
    createResult: text('create_result'),
  },
  (t) => [
    index('seatly_slots').on(t.sandboxKey, t.spaceId, t.bookingDate, t.status),
    index('seatly_status_date').on(t.sandboxKey, t.status, t.bookingDate, t.id),
    index('seatly_expiry').on(t.sandboxKey, t.status, t.expiresAt),
  ],
);

export const taskHistory = sqliteTable(
  'task_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: integer('task_id')
      .notNull()
      .references(() => tasks.id),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    memberId: integer('member_id').references(() => members.id),
    action: text('action').notNull(),
    beforeJson: text('before_json'),
    afterJson: text('after_json').notNull(),
    version: integer('version').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('task_history_workspace').on(t.workspaceId, t.id),
    uniqueIndex('task_history_version').on(t.taskId, t.version),
  ],
);
