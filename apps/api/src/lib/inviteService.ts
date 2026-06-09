/**
 * inviteService.ts — 团队邀请链接服务
 *
 * 功能:
 * - 生成邀请链接（带 token + 可选短码）
 * - 接受邀请（通过 token 或 code）
 * - 撤销邀请
 * - 查询团队的待定邀请列表
 * - 清理过期邀请
 */

import { eq, and, isNull, lt, desc } from 'drizzle-orm';
import { getDb, teamInvitations, teams, teamMembers, users } from '../db';
import type { DrizzleDb } from '../db';
import type { Env } from '../types/env';
import { logger } from '@osshelf/shared';

// ─────────────────────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateInviteInput {
  teamId: string;
  inviterUserId: string;
  role?: 'member' | 'guest';
  email?: string;
  message?: string;
  expiresInDays?: number;
  /** 可选：从路由层传入的真实 baseUrl，优先级高于环境变量 */
  requestBaseUrl?: string;
}

export interface InviteInfo {
  id: string;
  teamId: string;
  teamName: string;
  inviterName: string | null;
  inviterEmail: string | null;
  role: string;
  message: string | null;
  expiresAt: string | null;
  inviteUrl: string;
  inviteCode: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 生成邀请
// ─────────────────────────────────────────────────────────────────────────────

export async function createInvite(
  env: Env,
  inviterUserId: string,
  input: CreateInviteInput
): Promise<{ success: true; invite: InviteInfo } | { success: false; error: string }> {
  const db = getDb(env.DB);
  const { teamId, role = 'member', email, message, expiresInDays = 7 } = input;

  const team = await db.select().from(teams).where(eq(teams.id, teamId)).get();
  if (!team) return { success: false, error: '团队不存在' };

  const membership = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, inviterUserId)))
    .get();

  if (!membership || (membership.role !== 'admin' && membership.role !== 'owner')) {
    return { success: false, error: '只有管理员可以发送邀请' };
  }

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + expiresInDays * 86400000).toISOString();
  const token = crypto.randomUUID();
  const code = generateInviteCode();

  await db.insert(teamInvitations).values({
    id: crypto.randomUUID(),
    teamId,
    invitedBy: inviterUserId,
    inviteToken: token,
    inviteCode: code,
    email: email || null,
    role,
    message: message || null,
    expiresAt,
    status: 'pending',
    createdAt: now,
  });

  const inviter = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, inviterUserId)).get();
  // 优先使用请求传入的 baseUrl，其次环境变量，最后 fallback
  let baseUrl = input.requestBaseUrl || getBaseUrl(env);
  // 确保 baseUrl 不以 / 结尾
  if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

  logger.info('InviteService', '创建邀请', { teamId, inviterUserId, role, token: token.slice(0, 8) + '...' });

  return {
    success: true,
    invite: {
      id: token,
      teamId,
      teamName: team.name,
      inviterName: inviter?.name ?? null,
      inviterEmail: inviter?.email ?? null,
      role,
      message: message ?? null,
      expiresAt,
      inviteUrl: `${baseUrl}/invite/${token}`,
      inviteCode: code,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 接受邀请
// ─────────────────────────────────────────────────────────────────────────────

export async function acceptInvite(
  env: Env,
  token: string,
  acceptorUserId: string
): Promise<{ success: true; teamId: string; teamName: string; role: string } | { success: false; error: string }> {
  const db = getDb(env.DB);

  const invite = await db.select().from(teamInvitations).where(eq(teamInvitations.inviteToken, token)).get();
  if (!invite) return { success: false, error: '邀请链接无效或不存在' };
  if (invite.status !== 'pending') {
    const statusMessages: Record<string, string> = {
      accepted: '此邀请已被接受',
      revoked: '此邀请已被撤销',
      expired: '此邀请已过期',
    };
    return { success: false, error: statusMessages[invite.status] || '此邀请不可用' };
  }

  if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
    await db.update(teamInvitations).set({ status: 'expired' }).where(eq(teamInvitations.id, invite.id));
    return { success: false, error: '邀请已过期' };
  }

  if (invite.email) {
    const acceptor = await db.select({ email: users.email }).from(users).where(eq(users.id, acceptorUserId)).get();
    if (!acceptor || acceptor.email.toLowerCase() !== invite.email.toLowerCase()) {
      return { success: false, error: '此邀请仅限指定邮箱用户接受' };
    }
  }

  const team = await db.select().from(teams).where(eq(teams.id, invite.teamId)).get();
  if (!team) return { success: false, error: '关联的团队不存在' };

  const existingMembership = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, invite.teamId), eq(teamMembers.userId, acceptorUserId)))
    .get();
  if (existingMembership) return { success: false, error: '您已经是该团队成员' };

  const now = new Date().toISOString();

  await db.update(teamInvitations).set({
    status: 'accepted',
    acceptedBy: acceptorUserId,
    acceptedAt: now,
  }).where(eq(teamInvitations.id, invite.id));

  await db.insert(teamMembers).values({
    id: crypto.randomUUID(),
    teamId: invite.teamId,
    userId: acceptorUserId,
    role: invite.role,
    addedBy: invite.invitedBy,
    createdAt: now,
  });

  logger.info('InviteService', '接受邀请', { token: token.slice(0, 8) + '...', acceptorUserId, teamId: invite.teamId });
  return { success: true, teamId: invite.teamId, teamName: team.name, role: invite.role };
}

// ─────────────────────────────────────────────────────────────────────────────
// 通过短码接受邀请
// ─────────────────────────────────────────────────────────────────────────────

export async function acceptInviteByCode(
  env: Env,
  code: string,
  acceptorUserId: string
): Promise<ReturnType<typeof acceptInvite>> {
  const db = getDb(env.DB);
  const invite = await db
    .select()
    .from(teamInvitations)
    .where(and(eq(teamInvitations.inviteCode, code), eq(teamInvitations.status, 'pending')))
    .get();
  if (!invite) return { success: false, error: '邀请码无效或不存在' };
  return acceptInvite(env, invite.inviteToken, acceptorUserId);
}

// ─────────────────────────────────────────────────────────────────────────────
// 撤销邀请
// ─────────────────────────────────────────────────────────────────────────────

export async function revokeInvite(
  env: Env,
  teamId: string,
  inviteId: string,
  operatorUserId: string
): Promise<{ success: true } | { success: false; error: string }> {
  const db = getDb(env.DB);
  const invite = await db
    .select()
    .from(teamInvitations)
    .where(and(eq(teamInvitations.id, inviteId), eq(teamInvitations.teamId, teamId)))
    .get();
  if (!invite) return { success: false, error: '邀请记录不存在' };

  if (invite.invitedBy !== operatorUserId) {
    const membership = await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, operatorUserId)))
      .get();
    if (!membership || (membership.role !== 'admin' && membership.role !== 'owner')) {
      return { success: false, error: '无权撤销此邀请' };
    }
  }

  await db.update(teamInvitations).set({ status: 'revoked' }).where(eq(teamInvitations.id, inviteId));
  logger.info('InviteService', '撤销邀请', { inviteId, operatorUserId });
  return { success: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 列出待定邀请
// ─────────────────────────────────────────────────────────────────────────────

export interface PendingInviteItem {
  id: string;
  inviteToken: string;
  inviteCode: string | null;
  email: string | null;
  role: string;
  message: string | null;
  inviterName: string | null;
  inviterEmail: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export async function listPendingInvites(db: DrizzleDb, teamId: string): Promise<PendingInviteItem[]> {
  const invites = await db
    .select({
      id: teamInvitations.id,
      inviteToken: teamInvitations.inviteToken,
      inviteCode: teamInvitations.inviteCode,
      email: teamInvitations.email,
      role: teamInvitations.role,
      message: teamInvitations.message,
      inviterName: users.name,
      inviterEmail: users.email,
      expiresAt: teamInvitations.expiresAt,
      createdAt: teamInvitations.createdAt,
    })
    .from(teamInvitations)
    .innerJoin(users, eq(teamInvitations.invitedBy, users.id))
    .where(and(eq(teamInvitations.teamId, teamId), eq(teamInvitations.status, 'pending')))
    .orderBy(desc(teamInvitations.createdAt))
    .all();

  return invites.map((inv) => ({
    id: inv.id,
    inviteToken: inv.inviteToken,
    inviteCode: inv.inviteCode,
    email: inv.email,
    role: inv.role,
    message: inv.message,
    inviterName: inv.inviterName,
    inviterEmail: inv.inviterEmail,
    expiresAt: inv.expiresAt,
    createdAt: inv.createdAt,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 清理过期邀请
// ─────────────────────────────────────────────────────────────────────────────

export async function cleanupExpiredInvites(db: DrizzleDb): Promise<number> {
  const now = new Date().toISOString();
  const result = await db
    .update(teamInvitations)
    .set({ status: 'expired' })
    .where(
      and(
        eq(teamInvitations.status, 'pending'),
        isNull(teamInvitations.expiresAt),
        lt(teamInvitations.expiresAt, now)
      )
    );
  if (result.meta.changes > 0) {
    logger.info('InviteService', '清理过期邀请', { count: result.meta.changes });
  }
  return result.meta.changes;
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部工具函数
// ─────────────────────────────────────────────────────────────────────────────

function generateInviteCode(length = 6): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < length; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

function getBaseUrl(env: Env): string {
  try {
    const envObj = env as unknown as Record<string, unknown>;
    if (envObj.APP_URL && typeof envObj.APP_URL === 'string') return envObj.APP_URL;
  } catch {}
  return 'http://localhost:8788';
}
