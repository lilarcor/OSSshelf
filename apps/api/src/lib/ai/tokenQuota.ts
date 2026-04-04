/**
 * tokenQuota.ts
 * 基于 KV 的 Token 日配额控制系统（Cloudflare Workers 环境）
 *
 * 设计:
 * - 按用户 + 日期维度记录 token 用量
 * - 每次对话请求前检查剩余配额
 * - 对话完成后记录实际用量
 * - 配额每日自动重置（KV expirationTtl）
 */

import type { Env } from '../../types/env';
import { logger } from '@osshelf/shared';

const DAILY_TOKEN_QUOTA = 100_000;
const QUOTA_KV_PREFIX = 'tokenquota:';

export interface TokenQuotaResult {
  allowed: boolean;
  usedToday: number;
  remaining: number;
  quota: number;
  resetsAt?: string;
}

export async function checkTokenQuota(env: Env, userId: string): Promise<TokenQuotaResult> {
  const today = getTodayKey();
  const key = `${QUOTA_KV_PREFIX}${userId}:${today}`;

  try {
    const raw = await env.KV.get(key, 'json') as { used: number; quota: number } | null;

    if (raw === null) {
      return {
        allowed: true,
        usedToday: 0,
        remaining: DAILY_TOKEN_QUOTA,
        quota: DAILY_TOKEN_QUOTA,
      };
    }

    const used = raw.used || 0;
    const quota = raw.quota || DAILY_TOKEN_QUOTA;

    return {
      allowed: used < quota,
      usedToday: used,
      remaining: Math.max(0, quota - used),
      quota,
    };
  } catch (error) {
    logger.error('TokenQuota', 'KV read failed, allowing request', { userId }, error);
    return { allowed: true, usedToday: 0, remaining: DAILY_TOKEN_QUOTA, quota: DAILY_TOKEN_QUOTA };
  }
}

export async function recordTokenUsage(env: Env, userId: string, tokens: number): Promise<void> {
  if (tokens <= 0) return;

  const today = getTodayKey();
  const key = `${QUOTA_KV_PREFIX}${userId}:${today}`;
  const ttlSeconds = secondsUntilMidnight();

  try {
    const raw = await env.KV.get(key, 'json') as { used: number; quota: number } | null;
    const currentUsed = raw?.used || 0;
    const newUsed = currentUsed + tokens;

    await env.KV.put(
      key,
      JSON.stringify({ used: newUsed, quota: DAILY_TOKEN_QUOTA }),
      { expirationTtl: ttlSeconds }
    );
  } catch (error) {
    logger.error('TokenQuota', 'KV write failed', { userId, tokens }, error);
  }
}

export function tokenQuotaExceededResponse(result: TokenQuotaResult): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: {
        code: 'QUOTA_EXCEEDED',
        message: `今日 AI Token 用量已达上限 (${formatNumber(result.usedToday)} / ${formatNumber(result.quota)})。明日 ${MIDNIGHT_RESET_TIME} 自动重置。`,
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

export async function getTokenUsageStats(env: Env, userId: string): Promise<{
  today: { used: number; quota: number; remaining: number };
}> {
  const todayResult = await checkTokenQuota(env, userId);
  return {
    today: {
      used: todayResult.usedToday,
      quota: todayResult.quota,
      remaining: todayResult.remaining,
    },
  };
}

function getTodayKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function secondsUntilMidnight(): number {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  return Math.floor((tomorrow.getTime() - now.getTime()) / 1000);
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const MIDNIGHT_RESET_TIME = '00:00';
