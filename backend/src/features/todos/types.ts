import type { z } from 'zod';
import type { createSchema, updateSchema, todoSchema, listQuerySchema } from './validators.js';
import type { PrismaClient, Todo as PrismaTodo } from '../../generated/prisma/client.js';

export type TodoCreate = z.infer<typeof createSchema>;
export type TodoUpdate = z.infer<typeof updateSchema>;
export type Todo = z.infer<typeof todoSchema>;
export type TodoListFilter = z.infer<typeof listQuerySchema>;
export type TodoRecord = PrismaTodo;
export type Database = PrismaClient;
export interface TodoStore {
  list(filter?: TodoListFilter): Promise<Todo[]>;
  get(id: number): Promise<Todo | null>;
  create(payload: TodoCreate): Promise<Todo>;
  update(id: number, payload: TodoUpdate): Promise<Todo | null>;
  delete(id: number): Promise<boolean>;
}
