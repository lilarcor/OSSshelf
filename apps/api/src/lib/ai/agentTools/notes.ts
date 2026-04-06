/**
 * notes.ts — 笔记备注工具
 *
 * 功能:
 * - 写入/更新备注
 * - 获取文件备注列表
 * - 更新指定备注
 * - 删除/置顶备注
 */

import { eq, and, isNull, desc, sql } from 'drizzle-orm';
import { getDb, files, fileNotes } from '../../../db';
import type { Env } from '../../../types/env';
import type { ToolDefinition } from './types';

export const definitions: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'write_note',
      description: `【写入备注】为文件添加或更新备注。
如果已有备注则追加，否则创建新备注。`,
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: '文件的 UUID' },
          content: { type: 'string', description: '备注内容' },
          append: { type: 'boolean', description: '是否追加到现有备注，默认 true' },
          _confirmed: { type: 'boolean', description: '用户确认' },
        },
        required: ['fileId', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getFileNotes',
      description: `【获取备注列表】获取某个文件的所有备注记录。
按时间倒序排列。`,
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: '文件的 UUID' },
          limit: { type: 'number', description: '返回数量，默认 20' },
        },
        required: ['fileId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_note',
      description: `【更新备注内容】修改指定的备注记录。
适用场景："修改刚才写的备注"、"更正备注内容"`,
      parameters: {
        type: 'object',
        properties: {
          noteId: { type: 'string', description: '备注 ID' },
          content: { type: 'string', description: '新的备注内容' },
          _confirmed: { type: 'boolean', description: '用户确认' },
        },
        required: ['noteId', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_note',
      description: `【删除备注】删除指定的备注记录。
适用场景："删除这条备注"、"清理无用备注"`,
      parameters: {
        type: 'object',
        properties: {
          noteId: { type: 'string', description: '备注 ID' },
          _confirmed: { type: 'boolean', description: '用户确认（必须为true）' },
        },
        required: ['noteId', '_confirmed'],
      },
    },
  },
];

export class NotesTools {

  static async executeWriteNote(env: Env, userId: string, args: Record<string, unknown>) {
    const fileId = args.fileId as string;
    const content = args.content as string;
    const append = args.append !== false;
    const db = getDb(env.DB);

    const file = await db.select().from(files)
      .where(and(eq(files.id, fileId), eq(files.userId, userId), isNull(files.deletedAt)))
      .get();
    if (!file) return { error: '文件不存在或无权访问' };

    const now = new Date().toISOString();

    if (append) {
      const existingNotes = await db.select()
        .from(fileNotes)
        .where(and(eq(fileNotes.fileId, fileId), eq(fileNotes.userId, userId)))
        .orderBy(desc(fileNotes.createdAt))
        .limit(1)
        .all();

      if (existingNotes.length > 0) {
        const latestNote = existingNotes[0];
        await db.update(fileNotes).set({
          content: latestNote.content + '\n\n' + content,
          updatedAt: now,
        }).where(eq(fileNotes.id, latestNote.id));

        return {
          success: true,
          message: '备注已追加',
          noteId: latestNote.id,
          fileId,
          action: 'appended',
        };
      }
    }

    const noteId = crypto.randomUUID();

    await db.insert(fileNotes).values({
      id: noteId,
      userId,
      fileId,
      content,
      isPinned: false,
      createdAt: now,
      updatedAt: now,
    });

    await db.update(files).set({
      noteCount: sql`(SELECT COUNT(*) FROM ${fileNotes} WHERE ${fileNotes.fileId} = ${fileId})`,
      updatedAt: now,
    }).where(eq(files.id, fileId));

    return {
      success: true,
      message: '备注已创建',
      noteId,
      fileId,
      action: 'created',
    };
  }

  static async executeGetFileNotes(env: Env, userId: string, args: Record<string, unknown>) {
    const fileId = args.fileId as string;
    const limit = Math.min((args.limit as number) || 20, 50);
    const db = getDb(env.DB);

    const notes = await db.select()
      .from(fileNotes)
      .where(and(eq(fileNotes.fileId, fileId), eq(fileNotes.userId, userId)))
      .orderBy(desc(fileNotes.isPinned), desc(fileNotes.createdAt))
      .limit(limit)
      .all();

    return {
      fileId,
      total: notes.length,
      notes: notes.map((n) => ({
        id: n.id,
        content: n.content.length > 200 ? n.content.slice(0, 200) + '...' : n.content,
        fullContent: n.content,
        isPinned: n.isPinned,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
      })),
    };
  }

  static async executeUpdateNote(env: Env, userId: string, args: Record<string, unknown>) {
    const noteId = args.noteId as string;
    const content = args.content as string;
    const db = getDb(env.DB);

    const note = await db.select().from(fileNotes)
      .where(and(eq(fileNotes.id, noteId), eq(fileNotes.userId, userId)))
      .get();
    if (!note) return { error: '备注不存在' };

    await db.update(fileNotes).set({
      content,
      updatedAt: new Date().toISOString(),
    }).where(eq(fileNotes.id, noteId));

    return {
      success: true,
      message: '备注已更新',
      noteId,
      fileId: note.fileId,
    };
  }

  static async executeDeleteNote(env: Env, userId: string, args: Record<string, unknown>) {
    const noteId = args.noteId as string;
    const db = getDb(env.DB);

    const note = await db.select().from(fileNotes)
      .where(and(eq(fileNotes.id, noteId), eq(fileNotes.userId, userId)))
      .get();
    if (!note) return { error: '备注不存在' };

    await db.delete(fileNotes).where(eq(fileNotes.id, noteId));

    await db.update(files).set({
      noteCount: sql`(SELECT COUNT(*) FROM ${fileNotes} WHERE ${fileNotes.fileId} = ${note.fileId})`,
      updatedAt: new Date().toISOString(),
    }).where(eq(files.id, note.fileId));

    return {
      success: true,
      message: '备注已删除',
      noteId,
      fileId: note.fileId,
    };
  }
}
