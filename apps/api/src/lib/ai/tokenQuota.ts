/**
 * tokenQuota.ts
 * 基于数据库的 Token 配额控制系统
 *
 * 设计:
 * - 按用户 + 日期维度记录 token 用量
 * - 每次对话请求前检查剩余配额
 * - 对话完成后记录实际用量
 * - 支持历史记录查询
 * - 管理员不受配额限制
 */

import { eq, and, desc, gte } from 'drizzle-orm';
import { getDb, aiTokenUsage, type AiTokenUsage } from '../../db';
import type { Env } from '../../types/env';
import { logger } from '@osshelf/shared';

const DAILY_TOKEN_QUOTA = 100_000;
const ADMIN_QUOTA = 10_000_000;

export interface TokenQuotaResult {
  allowed: boolean;
  usedToday: number;
  remaining: number;
  quota: number;
  isAdmin?: boolean;
}

export interface TokenUsageRecord {
  id: string;
  userId: string;
  date: string;
  tokensUsed: number;
  quota: number;
  createdAt: string;
  updatedAt: string;
}

export interface TokenUsageHistory {
  date: string;
  tokensUsed: number;
  quota: number;
}

export async function checkTokenQuota(env: Env, userId: string, userRole?: string): Promise<TokenQuotaResult> {
  const isAdmin = userRole === 'admin';
  const today = getTodayKey();
  const quota = isAdmin ? ADMIN_QUOTA : DAILY_TOKEN_QUOTA;

  try {
    const db = getDb(env.DB);
    const record = await db
      .select()
      .from(aiTokenUsage)
      .where(and(eq(aiTokenUsage.userId, userId), eq(aiTokenUsage.date, today)))
      .get();

    const used = record?.tokensUsed || 0;

    if (isAdmin) {
      return {
        allowed: true,
        usedToday: used,
        remaining: ADMIN_QUOTA,
        quota: ADMIN_QUOTA,
        isAdmin: true,
      };
    }

    return {
      allowed: used < quota,
      usedToday: used,
      remaining: Math.max(0, quota - used),
      quota,
    };
  } catch (error) {
    logger.error('TokenQuota', 'Database read failed, allowing request', { userId }, error);
    return {
      allowed: true,
      usedToday: 0,
      remaining: isAdmin ? ADMIN_QUOTA : DAILY_TOKEN_QUOTA,
      quota: isAdmin ? ADMIN_QUOTA : DAILY_TOKEN_QUOTA,
      isAdmin,
    };
  }
}

export async function recordTokenUsage(env: Env, userId: string, tokens: number, userRole?: string): Promise<void> {
  if (tokens <= 0) return;

  const today = getTodayKey();
  const isAdmin = userRole === 'admin';
  const quota = isAdmin ? ADMIN_QUOTA : DAILY_TOKEN_QUOTA;

  try {
    const db = getDb(env.DB);
    const existing = await db
      .select()
      .from(aiTokenUsage)
      .where(and(eq(aiTokenUsage.userId, userId), eq(aiTokenUsage.date, today)))
      .get();

    const now = new Date().toISOString();

    if (existing) {
      await db
        .update(aiTokenUsage)
        .set({
          tokensUsed: existing.tokensUsed + tokens,
          updatedAt: now,
        })
        .where(eq(aiTokenUsage.id, existing.id));
    } else {
      await db.insert(aiTokenUsage).values({
        id: crypto.randomUUID(),
        userId,
        date: today,
        tokensUsed: tokens,
        quota,
        createdAt: now,
        updatedAt: now,
      });
    }
  } catch (error) {
    logger.error('TokenQuota', 'Database write failed', { userId, tokens }, error);
  }
}

export function tokenQuotaExceededResponse(result: TokenQuotaResult): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: {
        code: 'QUOTA_EXCEEDED',
        message: `今日 AI Token 用量已达上限 (${formatNumber(result.usedToday)} / ${formatNumber(result.quota)})。明日 00:00 自动重置。`,
        usedToday: result.usedToday,
        remaining: result.remaining,
        quota: result.quota,
        resetsAt: '次日 00:00 (UTC+8)',
      },
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'X-Token-Used-Today': String(result.usedToday),
        'X-Token-Remaining': String(result.remaining),
        'X-Token-Quota': String(result.quota),
      },
    }
  );
}

export async function getTokenUsageStats(
  env: Env,
  userId: string,
  userRole?: string
): Promise<{
  today: { used: number; quota: number; remaining: number; isAdmin?: boolean };
  history: TokenUsageHistory[];
}> {
  const todayResult = await checkTokenQuota(env, userId, userRole);
  const history = await getTokenUsageHistory(env, userId, 30);

  return {
    today: {
      used: todayResult.usedToday,
      quota: todayResult.quota,
      remaining: todayResult.remaining,
      isAdmin: todayResult.isAdmin,
    },
    history,
  };
}

export async function getTokenUsageHistory(env: Env, userId: string, days: number = 30): Promise<TokenUsageHistory[]> {
  try {
    const db = getDb(env.DB);
    const startDate = getDateString(daysBefore(days));

    const records = await db
      .select()
      .from(aiTokenUsage)
      .where(and(eq(aiTokenUsage.userId, userId), gte(aiTokenUsage.date, startDate)))
      .orderBy(desc(aiTokenUsage.date))
      .all();

    return records.map((r: AiTokenUsage) => ({
      date: r.date,
      tokensUsed: r.tokensUsed,
      quota: r.quota,
    }));
  } catch (error) {
    logger.error('TokenQuota', 'Failed to get token usage history', { userId }, error);
    return [];
  }
}

function getTodayKey(): string {
  return getDateString(new Date());
}

function getDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function daysBefore(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
