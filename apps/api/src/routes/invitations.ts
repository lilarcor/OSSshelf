/**
 * invitations.ts — 公开邀请路由（无需登录查看，接受需登录）
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb, teamInvitations, teams, users } from '../db';
import { authMiddleware } from '../middleware/auth';
import { throwAppError } from '../middleware/error';
import type { Env, Variables } from '../types/env';

const publicApp = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── 公开：查看邀请详情（不需要登录）──

publicApp.get('/:token', async (c) => {
  const token = c.req.param('token');
  const db = getDb(c.env.DB);

  const invite = await db
    .select({
      id: teamInvitations.id,
      teamId: teamInvitations.teamId,
      teamName: teams.name,
      teamDescription: teams.description,
      inviterName: users.name,
      inviterEmail: users.email,
      role: teamInvitations.role,
      message: teamInvitations.message,
      expiresAt: teamInvitations.expiresAt,
      status: teamInvitations.status,
      createdAt: teamInvitations.createdAt,
    })
    .from(teamInvitations)
    .innerJoin(teams, eq(teamInvitations.teamId, teams.id))
    .innerJoin(users, eq(teamInvitations.invitedBy, users.id))
    .where(eq(teamInvitations.inviteToken, token))
    .get();

  if (!invite) throwAppError('INVITE_NOT_FOUND', '邀请链接无效');

  // 检查状态
  if (invite.status !== 'pending' || (invite.expiresAt && new Date(invite.expiresAt) < new Date())) {
    const displayStatus = invite.status === 'pending' ? 'expired' : invite.status;
    return c.json({ success: true, data: { ...invite, status: displayStatus } });
  }

  return c.json({ success: true, data: { ...invite, status: 'pending' } });
});

// 通过短码查询 → 重定向到 token 接口
publicApp.get('/code/:code', async (c) => {
  const code = c.req.param('code');
  const db = getDb(c.env.DB);

  const invite = await db
    .select({ inviteToken: teamInvitations.inviteToken })
    .from(teamInvitations)
    .where(eq(teamInvitations.inviteCode, code))
    .get();

  if (!invite) throwAppError('INVITE_NOT_FOUND', '邀请码无效');
  return c.redirect(`/api/invite/${invite.inviteToken}`);
});

// ── 受保护：接受邀请（需要登录）──

const protectedApp = new Hono<{ Bindings: Env; Variables: Variables }>();
protectedApp.use('*', authMiddleware);

protectedApp.post('/:token/accept', async (c) => {
  const userId = c.get('userId')!;
  const token = c.req.param('token');

  const { acceptInvite } = await import('../lib/inviteService');
  const result = await acceptInvite(c.env, token, userId);
  if (!result.success) {
    throwAppError('INVITE_ACCEPT_FAILED', (result as { error: string }).error);
  }
  return c.json({ success: true, data: result });
});

protectedApp.post('/code/:code/accept', async (c) => {
  const userId = c.get('userId')!;
  const code = c.req.param('code');

  const { acceptInviteByCode } = await import('../lib/inviteService');
  const result = await acceptInviteByCode(c.env, code, userId);
  if (!result.success) {
    throwAppError('INVITE_ACCEPT_FAILED', (result as { error: string }).error);
  }
  return c.json({ success: true, data: result });
});

export { publicApp as invitePublicRoutes, protectedApp as inviteProtectedRoutes };
