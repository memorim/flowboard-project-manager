import { z } from 'zod';
export const taskSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    description: z.string().trim().max(500).default(''),
    status: z.enum(['todo', 'in_progress', 'review', 'done']).default('todo'),
    priority: z.enum(['low', 'medium', 'high']),
    projectId: z.number().int().positive(),
    assigneeId: z.number().int().positive().nullable(),
    dueDate: z.string().date(),
  })
  .strict();
