# 团队协作功能重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将团队功能从"权限组的拙劣副本"重构为小型团队协作工作空间，具备独立于权限组的四个差异化能力：团队工作区视图、邀请机制、团队存储空间、协作交互。

**Architecture:** 后端新增 team_invitations、team_activities 两张表，扩展 teams 表增加存储配额字段；teamService 重写为以"工作空间"为核心的协作服务层，新增邀请链接生成/接受/撤销、团队文件浏览（基于已挂载资源 + 权限解析）、活动记录等能力。前端将 /teams 页面从卡片列表升级为工作空间入口，新增 /teams/:teamId/workspace 路由提供独立文件浏览器，新增邀请对话框、活动时间线、存储用量条等组件。与权限组的关系明确为：权限组管"谁能看哪些文件"，团队管"一群人围绕共享资源的协作空间"。

**Tech Stack:** React 18 + React Router v6 + TanStack Query v5 + Tailwind CSS (frontend); Hono + Drizzle ORM + SQLite (backend, Cloudflare Workers); Zod (validation); lucide-react (icons)

---

## 文件结构总览

### 新建文件
| 文件 | 职责 |
|------|------|
| `apps/api/migrations/101_team_v2.sql` | 数据库迁移：新表 + teams 表字段扩展 |
| `apps/api/src/lib/inviteService.ts` | 邀请链接服务：生成/接受/撤销/过期清理 |
| `apps/api/src/lib/teamActivityService.ts` | 团队活动流服务：记录/查询/通知 |
| `apps/api/src/routes/invitations.ts` | 邀请公开路由（无需登录即可访问） |
| `apps/web/src/components/teams/TeamWorkspace.tsx` | **核心**：团队工作区文件浏览器 |
| `apps/web/src/components/teams/TeamInviteDialog.tsx` | 邀请成员对话框（链接/邮箱） |
| `apps/web/src/components/teams/TeamActivityFeed.tsx` | 活动时间线组件 |
| `apps/web/src/components/teams/TeamStorageBar.tsx` | 存储用量展示组件 |
| `apps/web/src/pages/TeamWorkspace.tsx` | 工作区页面容器 |

### 修改文件
| 文件 | 改动范围 |
|------|----------|
| `apps/api/src/db/schema.ts` | teams 表加 storageQuota/storageUsed/defaultRole 字段；新增 teamInvitations、teamActivities 表 |
| `apps/api/src/lib/teamService.ts` | 重写：保留 CRUD + 成员管理，重写资源挂载逻辑（挂载时同步授权），新增 getTeamFiles（工作区文件列表） |
| `apps/api/src/routes/teams.ts` | 新增 workspace 文件浏览端点、邀请管理端点、活动查询端点、存储统计端点 |
| `apps/web/src/services/collab.ts` | teamsApi 扩展：workspace files / invite / activities / storage |
| `apps/web/src/pages/Teams.tsx` | 从简单包装 TeamList 升级为工作空间入口页 |
| `apps/web/src/components/teams/TeamList.tsx` | 卡片增加"进入工作区"按钮和存储用量预览 |
| `apps/web/src/components/teams/TeamDetail.tsx` | Tab 增加"活动"面板，设置面板增加存储配额 |
| `apps/web/src/App.tsx` | 新增 `/teams/:teamId/workspace` 和 `/teams/:teamId` 路由 |
| `apps/web/src/LazyComponents.tsx` | 新增 LazyTeamWorkspace 懒加载组件 |
| `apps/web/src/components/layouts/MainLayout.tsx` | 侧边栏 Teams 高亮逻辑适配子路由 |

---

### Task 1: 数据库 Schema 扩展 + 迁移

**Files:**
- Modify: `apps/api/src/db/schema.ts:802-905`
- Create: `apps/api/migrations/101_team_v2.sql`

- [ ] **Step 1: 扩展 teams 表定义**

在 `apps/api/src/db/schema.ts` 的 teams 表定义（约 L806-L822）中，在 `settings` 字段后添加三个新字段：

```typescript
export const teams = sqliteTable(
  'teams',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    settings: text('settings').default('{}'),
    // ── 新增字段 ─-
    storageQuota: integer('storage_quota').default(5368709120), // 5GB 默认
    storageUsed: integer('storage_used').default(0).notNull(),
    defaultMemberRole: text('default_member_role').default('member'), // 新成员默认角色
    // ───────────────
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    ownerIdx: index('idx_teams_owner').on(table.ownerId),
  })
);
```

- [ ] **Step 2: 新增 teamInvitations 表**

在 `apps/api/src/db/schema.ts` 的 `permissionRequests` 表定义之后添加：

```typescript
export const teamInvitations = sqliteTable(
  'team_invitations',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    invitedBy: text('invited_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    inviteToken: text('invite_token').notNull().unique(),
    inviteCode: text('invite_code').unique(), // 可选短码，如 ABC123
    email: text('email'), // 可选：指定邮箱
    role: text('role').notNull().default('member'),
    message: text('message'), // 邀请附言
    expiresAt: text('expires_at'),
    acceptedBy: text('accepted_by').references(() => users.id, { onDelete: 'set null' }),
    acceptedAt: text('accepted_at'),
    status: text('status').notNull().default('pending'), // pending | accepted | expired | revoked
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    teamIdx: index('idx_team_invitations_team').on(table.teamId),
    tokenIdx: index('idx_team_invitations_token').on(table.inviteToken),
    statusIdx: index('idx_team_invitations_status').on(table.status),
    expiresIdx: index('idx_team_invitations_expires').on(table.expiresAt),
  })
);
```

- [ ] **Step 3: 新增 teamActivities 表**

在 `teamInvitations` 表之后添加：

```typescript
export const teamActivities = sqliteTable(
  'team_activities',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(), // member_joined | member_left | role_changed | file_mounted | file_unmounted | file_uploaded | file_deleted | comment_added
    resourceType: text('resource_type'), // file | member | team
    resourceId: text('resource_id'),
    details: text('details'), // JSON: { fileName, roleName, ... }
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    teamIdx: index('idx_team_activities_team').on(table.teamId, table.createdAt),
    userIdx: index('idx_team_activities_user').on(table.userId),
    actionIdx: index('idx_team_activities_action').on(table.action),
  })
);
```

- [ ] **Step 4: 在 db/index.ts 中导出新表**

确认 `apps/api/src/db/index.ts` 导出了所有表。在该文件的导出列表中追加：

```typescript
export { teamInvitations, teamActivities } from './schema';
```

同时更新 `teamMembers` 和 `teamResources` 导出（如果尚未导出）。

- [ ] **Step 5: 创建迁移文件**

创建 `apps/api/migrations/101_team_v2.sql`：

```sql
-- ============================================================
-- 101_team_v2.sql — 团队协作 V2：邀请机制 + 工作空间 + 活动
-- ============================================================

-- 1. 扩展 teams 表
ALTER TABLE teams ADD COLUMN storage_quota INTEGER DEFAULT 5368709120;
ALTER TABLE teams ADD COLUMN storage_used INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE teams ADD COLUMN default_member_role TEXT DEFAULT 'member';

-- 2. 邀请链接表
CREATE TABLE IF NOT EXISTS team_invitations (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_token TEXT NOT NULL UNIQUE,
  invite_code TEXT UNIQUE,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  message TEXT,
  expires_at TEXT,
  accepted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  accepted_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_invitations_team ON team_invitations(team_id);
CREATE INDEX IF NOT EXISTS idx_team_invitations_token ON team_invitations(invite_token);
CREATE INDEX IF NOT EXISTS idx_team_invitations_status ON team_invitations(status);
CREATE INDEX IF NOT EXISTS idx_team_invitations_expires ON team_invitations(expires_at);

-- 3. 活动流表
CREATE TABLE IF NOT EXISTS team_activities (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  details TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_activities_team ON team_activities(team_id, created_at);
CREATE INDEX IF NOT EXISTS idx_team_activities_user ON team_activities(user_id);
CREATE INDEX IF NOT EXISTS idx_team_activities_action ON team_activities(action);
```

- [ ] **Step 6: 验证编译通过**

Run: `cd apps/api && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/src/db/index.ts apps/api/migrations/101_team_v2.sql
git commit -m "feat(team): add invitation/activity tables and extend teams schema"
```

---

### Task 2: 邀请服务 (inviteService)

**Files:**
- Create: `apps/api/src/lib/inviteService.ts`
- Modify: `apps/api/src/routes/invitations.ts` (新建路由文件)

- [ ] **Step 1: 创建 inviteService.ts**

创建 `apps/api/src/lib/inviteService.ts`：

```typescript
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

import { eq, and, isNull, lt, sql, desc } from 'drizzle-orm';
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
  role?: 'member' | 'guest'; // 不允许直接邀为 admin/owner
  email?: string; // 可选：限定邮箱
  message?: string; // 邀请附言
  expiresInDays?: number; // 默认 7 天
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

  // 验证团队存在且操作者是 admin/owner
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

  // 获取邀请者信息
  const inviter = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, inviterUserId)).get();

  const baseUrl = getBaseUrl(env);

  logger.info('InviteService', '创建邀请', { teamId, inviterUserId, role, token: token.slice(0, 8) + '...' });

  return {
    success: true,
    invite: {
      id: token, // 前端用 token 作为引用 ID
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

  const invite = await db
    .select()
    .from(teamInvitations)
    .where(eq(teamInvitations.inviteToken, token))
    .get();

  if (!invite) return { success: false, error: '邀请链接无效或不存在' };
  if (invite.status !== 'pending') {
    if (invite.status === 'accepted') return { success: false, error: '此邀请已被接受' };
    if (invite.status === 'revoked') return { success: false, error: '此邀请已被撤销' };
    if (invite.status === 'expired') return { success: false, error: '此邀请已过期' };
    return { success: false, error: '此邀请不可用' };
  }

  if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
    // 标记为过期
    await db.update(teamInvitations).set({ status: 'expired' }).where(eq(teamInvitations.id, invite.id));
    return { success: false, error: '邀请已过期' };
  }

  // 如果限定了邮箱，验证接受者邮箱
  if (invite.email) {
    const acceptor = await db.select({ email: users.email }).from(users).where(eq(users.id, acceptorUserId)).get();
    if (!acceptor || acceptor.email.toLowerCase() !== invite.email.toLowerCase()) {
      return { success: false, error: '此邀请仅限指定邮箱用户接受' };
    }
  }

  const team = await db.select().from(teams).where(eq(teams.id, invite.teamId)).get();
  if (!team) return { success: false, error: '关联的团队不存在' };

  // 检查是否已是成员
  const existingMembership = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, invite.teamId), eq(teamMembers.userId, acceptorUserId)))
    .get();

  if (existingMembership) {
    return { success: false, error: '您已经是该团队成员' };
  }

  const now = new Date().toISOString();

  // 标记邀请为已接受
  await db
    .update(teamInvitations)
    .set({
      status: 'accepted',
      acceptedBy: acceptorUserId,
      acceptedAt: now,
    })
    .where(eq(teamInvitations.id, invite.id));

  // 添加到团队成员
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

  // 只有邀请者或团队 admin/owner 可以撤销
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

  await db
    .update(teamInvitations)
    .set({ status: 'revoked' })
    .where(eq(teamInvitations.id, inviteId));

  logger.info('InviteService', '撤销邀请', { inviteId, operatorUserId });
  return { success: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 列出团队的待定邀请
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

export async function listPendingInvites(
  db: DrizzleDb,
  teamId: string
): Promise<PendingInviteItem[]> {
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
// 清理过期邀请（定时任务调用）
// ─────────────────────────────────────────────────────────────────────────────

export async function cleanupExpiredInvites(db: DrizzleDb): Promise<number> {
  const now = new Date().toISOString();
  const result = await db
    .update(teamInvitations)
    .set({ status: 'expired' })
    .where(
      and(
        eq(teamInvitations.status, 'pending'),
        isNotNull(teamInvitations.expiresAt),
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
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆字符
  let code = '';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < length; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

function getBaseUrl(env: Env): string {
  // Cloudflare Workers 环境中获取应用 URL
  // 兼容开发环境
  return typeof env !== 'undefined' && (env as Record<string, unknown>).APP_URL
    ? (env as Record<string, unknown>).APP_URL as string
    : 'http://localhost:8788';
}
```

- [ ] **Step 2: 验证编译通过**

Run: `cd apps/api && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/inviteService.ts
git commit -m "feat(team): add invite service with token/code based invitations"
```

---

### Task 3: 团队活动服务 (teamActivityService)

**Files:**
- Create: `apps/api/src/lib/teamActivityService.ts`

- [ ] **Step 1: 创建 teamActivityService.ts**

创建 `apps/api/src/lib/teamActivityService.ts`：

```typescript
/**
 * teamActivityService.ts — 团队活动流服务
 *
 * 功能:
 * - 记录团队内事件（成员变更、文件操作等）
 * - 查询团队活动时间线
 * - 与 notification 系统联动
 */

import { eq, and, desc, sql } from 'drizzle-orm';
import { getDb, teamActivities, teams, teamMembers, users } from '../db';
import type { DrizzleDb } from '../db';
import type { Env } from '../types/env';
import { logger } from '@osshelf/shared';

// ─────────────────────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────────────────────

export type TeamAction =
  | 'member_joined'
  | 'member_left'
  | 'role_changed'
  | 'file_mounted'
  | 'file_unmounted'
  | 'file_uploaded'
  | 'file_deleted'
  | 'comment_added'
  | 'team_created'
  | 'team_settings_updated'
  | 'invite_sent'
  | 'invite_accepted';

export interface CreateActivityInput {
  teamId: string;
  userId: string;
  action: TeamAction;
  resourceType?: 'file' | 'member' | 'team' | 'invite';
  resourceId?: string;
  details?: Record<string, unknown>;
}

export interface ActivityItem {
  id: string;
  userId: string;
  userName: string | null;
  userAvatar: string | null; // 未来可扩展
  action: TeamAction;
  resourceType: string | null;
  resourceId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 记录活动
// ─────────────────────────────────────────────────────────────────────────────

export async function recordActivity(
  db: DrizzleDb,
  input: CreateActivityInput
): Promise<void> {
  const { teamId, userId, action, resourceType, resourceId, details } = input;

  await db.insert(teamActivities).values({
    id: crypto.randomUUID(),
    teamId,
    userId,
    action,
    resourceType: resourceType ?? null,
    resourceId: resourceId ?? null,
    details: details ? JSON.stringify(details) : null,
    createdAt: new Date().toISOString(),
  });
}

// 带环境参数的便捷方法（用于 service 层调用时无 db 实例的场景）
export async function recordActivityWithEnv(
  env: Env,
  input: CreateActivityInput
): Promise<void> {
  const db = getDb(env.DB);
  await recordActivity(db, input);
}

// ─────────────────────────────────────────────────────────────────────────────
// 查询团队活动时间线
// ─────────────────────────────────────────────────────────────────────────────

export interface ListActivitiesInput {
  teamId: string;
  limit?: number;
  offset?: number;
  actions?: TeamAction[]; // 过滤特定动作类型
}

export async function listTeamActivities(
  db: DrizzleDb,
  input: ListActivitiesInput
): Promise<{ items: ActivityItem[]; total: number }> {
  const { teamId, limit = 30, offset = 0, actions } = input;

  let conditions = [eq(teamActivities.teamId, teamId)];
  if (actions && actions.length > 0) {
    conditions.push(sql`${teamActivities.action} IN (${...actions})`);
  }

  const items = await db
    .select({
      id: teamActivities.id,
      userId: teamActivities.userId,
      userName: users.name,
      action: teamActivities.action,
      resourceType: teamActivities.resourceType,
      resourceId: teamActivities.resourceId,
      details: teamActivities.details,
      createdAt: teamActivities.createdAt,
    })
    .from(teamActivities)
    .leftJoin(users, eq(teamActivities.userId, users.id))
    where(and(...conditions))
    .orderBy(desc(teamActivities.createdAt))
    .limit(limit)
    .offset(offset)
    .all();

  // 解析 JSON details
  const parsedItems: ActivityItem[] = items.map((item) => ({
    ...item,
    details: item.details ? (JSON.parse(item.details) as Record<string, unknown>) : null,
    userAvatar: null,
  }));

  // 总数查询
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(teamActivities)
    .where(and(...conditions))
    .get();

  return {
    items: parsedItems,
    total: Number(countResult?.count ?? 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Action → 中文描述映射（供前端使用）
// ─────────────────────────────────────────────────────────────────────────────

export const ACTION_LABELS: Record<TeamAction, string> = {
  member_joined: '加入了团队',
  member_left: '离开了团队',
  role_changed: '变更了成员角色',
  file_mounted: '挂载了文件',
  file_unmounted: '卸载了文件',
  file_uploaded: '上传了文件',
  file_deleted: '删除了文件',
  comment_added: '发表了评论',
  team_created: '创建了团队',
  team_settings_updated: '更新了团队设置',
  invite_sent: '发送了邀请',
  invite_accepted: '接受了邀请',
};

// 辅助函数：根据 action + details 生成人类可读的活动描述
export function formatActivityDescription(activity: ActivityItem): string {
  const userName = activity.userName || '某人';
  const label = ACTION_LABELS[activity.action] || activity.action;

  const detailStr = formatDetails(activity.action, activity.details);
  return detailStr ? `${userName} ${label}：${detailStr}` : `${userName} ${label}`;
}

function formatDetails(action: TeamAction, details: Record<string, unknown> | null): string {
  if (!details) return '';

  switch (action) {
    case 'member_joined':
      return details.targetUserName ? `欢迎 ${details.targetUserName} 加入` : '';
    case 'role_changed':
      return `${details.targetUserName || '某成员'} → ${details.newRole || ''}`;
    case 'file_mounted':
    case 'file_unmounted':
      return details.fileName || '';
    case 'file_uploaded':
    case 'file_deleted':
      return details.fileName || '';
    case 'comment_added':
      return details.fileName ? `《${details.fileName}》` : '';
    case 'invite_sent':
      return details.targetEmail || details.targetCode || '';
    case 'invite_accepted':
      return '';
    default:
      return '';
  }
}
```

- [ ] **Step 2: 验证编译通过**

Run: `cd apps/api && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/teamActivityService.ts
git commit -m "feat(team): add team activity feed service"
```

---

### Task 4: 重写 teamService — 工作空间核心

**Files:**
- Modify: `apps/api/src/lib/teamService.ts` (全面改写)

这是最核心的改动。保留现有 CRUD + 成员管理不变，重点改造：
1. **资源挂载时自动同步写入 file_permissions**
2. **新增 `getTeamFiles()` — 工作区文件列表（合并所有已挂载资源 + 权限过滤）**
3. **所有成员变更操作后自动写入 activity log**

- [ ] **Step 1: 重写 teamService.ts**

完整替换 `apps/api/src/lib/teamService.ts` 为以下内容（保留原有签名兼容，新增函数）：

```typescript
/**
 * teamService.ts — 团队管理核心服务层 V2
 *
 * 变更点:
 * - mountResourceToTeam: 挂载时同步创建 file_permissions 记录
 * - unmountFromTeam: 卸载时同步清理关联的 file_permissions
 * - 新增 getTeamFiles(): 工作区文件聚合视图
 * - 所有成员操作联动 activity 记录
 */

import { eq, and, isNull, sql, or, inArray } from 'drizzle-orm';
import {
  getDb, teams, teamMembers, teamResources, files, users,
  filePermissions, teamActivities, teamInvitations
} from '../db';
import type { DrizzleDb } from '../db';
import type { Env } from '../types/env';
import { logger } from '@osshelf/shared';
import {
  recordActivity,
  type CreateActivityInput,
  type TeamAction
} from './teamActivityService';

// ─────────────────────────────────────────────────────────────────────────────
// 类型定义（保持向后兼容）
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateTeamInput {
  name: string;
  description?: string;
}

export interface UpdateTeamInput {
  name?: string;
  description?: string;
  defaultMemberRole?: string;
  storageQuota?: number;
}

export interface ManageTeamMembersInput {
  action: 'add' | 'remove' | 'change_role';
  targetUserId: string;
  role?: 'owner' | 'admin' | 'member' | 'guest';
}

/** 工作区文件条目 */
export interface TeamFileItem {
  fileId: string;
  fileName: string;
  filePath: string | null;
  fileType: string | null;
  mimeType: string | null;
  size: number;
  isFolder: boolean;
  mountedAt: string;
  permission: 'read' | 'write' | 'admin'; // 当前用户在此团队中的有效权限
}

// ─────────────────────────────────────────────────────────────────────────────
// 团队 CRUD（保持原有实现，增加 activity 记录）
// ─────────────────────────────────────────────────────────────────────────────

export async function createTeam(
  env: Env,
  userId: string,
  input: CreateTeamInput
): Promise<{ success: true; teamId: string; message: string } | { success: false; error: string }> {
  const db = getDb(env.DB);
  const { name, description } = input;

  if (!name || name.trim().length === 0) {
    return { success: false, error: '团队名称不能为空' };
  }

  const now = new Date().toISOString();
  const teamId = crypto.randomUUID();

  await db.insert(teams).values({
    id: teamId,
    ownerId: userId,
    name: name.trim(),
    description: description?.trim() || null,
    settings: '{}',
    storageQuota: 5368709120, // 5GB
    storageUsed: 0,
    defaultMemberRole: 'member',
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(teamMembers).values({
    id: crypto.randomUUID(),
    teamId,
    userId,
    role: 'owner',
    addedBy: userId,
    createdAt: now,
  });

  // Activity
  await recordActivity(db, {
    teamId,
    userId,
    action: 'team_created',
    resourceType: 'team',
    resourceId: teamId,
    details: { teamName: name.trim() },
  });

  logger.info('TeamService', '创建团队', { userId, teamId, name });
  return { success: true, teamId, message: `团队 "${name}" 创建成功` };
}

// getTeam, updateTeam, deleteTeam, listTeams 保持原有实现不变
// （此处省略重复代码，实际替换时保留原实现）

// ... [原有的 getTeam, updateTeam, deleteTeam, listTeams 函数原样保留] ...

// updateTeam 增加 activity:
// 在成功 update 后追加:
//   await recordActivity(db, { teamId, userId, action: 'team_settings_updated', details: updates });

// ─────────────────────────────────────────────────────────────────────────────
// 成员管理（每个操作后追加 activity 记录）
// ─────────────────────────────────────────────────────────────────────────────

export async function manageTeamMembers(
  env: Env,
  userId: string,
  teamId: string,
  input: ManageTeamMembersInput
): Promise<Record<string, unknown>> {
  const db = getDb(env.DB);
  const { action, targetUserId, role } = input;

  const team = await db.select().from(teams).where(eq(teams.id, teamId)).get();
  if (!team) return { success: false, error: '团队不存在' };

  const operatorMembership = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .get();
  if (!operatorMembership) return { success: false, error: '您不是该团队成员' };

  const now = new Date().toISOString();
  const targetUser = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, targetUserId)).get();

  switch (action) {
    case 'add': {
      // ... 原 add 逻辑不变 ...
      // 成功后追加:
      const result = /* 原 add 逻辑返回值 */;
      if ((result as { success: boolean }).success) {
        await recordActivity(db, {
          teamId, userId, action: 'member_joined', resourceType: 'member',
          resourceId: targetUserId,
          details: { targetUserName: targetUser?.name, targetUserEmail: targetUser?.email, role: role || 'member' },
        });
      }
      return result;
    }

    case 'remove': {
      // ... 原 remove 逻辑不变 ...
      // 成功后追加:
      const result = /* 原 remove 逻辑返回值 */;
      if ((result as { success: boolean }).success) {
        await recordActivity(db, {
          teamId, userId, action: 'member_left', resourceType: 'member',
          resourceId: targetUserId,
          details: { targetUserName: targetUser?.name, isSelf: targetUserId === userId },
        });
      }
      return result;
    }

    case 'change_role': {
      // ... 原 change_role 逻辑不变 ...
      // 成功后追加:
      const result = /* 原 change_role 逻辑返回值 */;
      if ((result as { success: boolean }).success) {
        await recordActivity(db, {
          teamId, userId, action: 'role_changed', resourceType: 'member',
          resourceId: targetUserId,
          details: { targetUserName: targetUser?.name, newRole: role },
        });
      }
      return result;
    }

    default:
      return { success: false, error: `未知操作: ${action}` };
  }
}

// listTeamMembers 保持原实现不变

// ─────────────────────────────────────────────────────────────────────────────
// 资源挂载/卸载（V2 核心：同步 file_permissions）
// ─────────────────────────────────────────────────────────────────────────────

export async function mountResourceToTeam(
  env: Env,
  userId: string,
  teamId: string,
  fileId: string
): Promise<{ success: true; message: string } | { success: false; error: string }> {
  const db = getDb(env.DB);

  const team = await db.select().from(teams).where(eq(teams.id, teamId)).get();
  if (!team) return { success: false, error: '团队不存在' };

  const membership = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .get();
  if (!membership) return { success: false, error: '您不是该团队成员' };

  const file = await db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), isNull(files.deletedAt)))
    .get();
  if (!file) return { success: false, error: '文件不存在或已被删除' };

  const isFileOwner = file.userId === userId;
  const isTeamAdminOrOwner = membership.role === 'admin' || membership.role === 'owner';
  if (!isFileOwner && !isTeamAdminOrOwner) {
    return { success: false, error: '只有文件所有者或团队管理员可以挂载资源' };
  }

  const existingMount = await db
    .select()
    .from(teamResources)
    .where(and(eq(teamResources.teamId, teamId), eq(teamResources.fileId, fileId)))
    .get();
  if (existingMount) return { success: false, error: '该资源已挂载到团队' };

  const now = new Date().toISOString();

  // 1. 写入挂载记录
  await db.insert(teamResources).values({
    id: crypto.randomUUID(),
    teamId,
    fileId,
    mountedBy: userId,
    mountedAt: now,
  });

  // 2. ★ V2 核心：同步创建 team 级别的 file_permissions
  //    给整个团队授予 read 权限（后续可通过 FilePermissionsDialog 细调）
  const existingPerm = await db
    .select()
    .from(filePermissions)
    .where(
      and(
        eq(filePermissions.fileId, fileId),
        eq(filePermissions.subjectType, 'team'),
        eq(filePermissions.teamId, teamId)
      )
    )
    .get();

  if (!existingPerm) {
    await db.insert(filePermissions).values({
      id: crypto.randomUUID(),
      fileId,
      userId: null,
      groupId: null,
      teamId,
      subjectType: 'team',
      permission: 'read', // 默认只读，管理员可后续提升
      grantedBy: userId,
      inheritToChildren: file.isFolder ? true : true,
      scope: 'explicit',
      createdAt: now,
      updatedAt: now,
    });
  }

  // Activity
  await recordActivity(db, {
    teamId,
    userId,
    action: 'file_mounted',
    resourceType: 'file',
    resourceId: fileId,
    details: { fileName: file.name, isFolder: file.isFolder },
  });

  logger.info('TeamService', '挂载资源到团队（含权限同步）', { userId, teamId, fileId });
  return { success: true, message: `文件 "${file.name}" 已挂载到团队 "${team.name}"` };
}

export async function unmountResourceFromTeam(
  env: Env,
  userId: string,
  teamId: string,
  fileId: string
): Promise<{ success: true; message: string } | { success: false; error: string }> {
  const db = getDb(env.DB);

  const team = await db.select().from(teams).where(eq(teams.id, teamId)).get();
  if (!team) return { success: false, error: '团队不存在' };

  const membership = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .get();
  if (!membership) return { success: false, error: '您不是该团队成员' };

  const file = await db.select().from(files).where(eq(files.id, fileId)).get();
  if (!file) return { success: false, error: '文件不存在' };

  const mountRecord = await db
    .select()
    .from(teamResources)
    .where(and(eq(teamResources.teamId, teamId), eq(teamResources.fileId, fileId)))
    .get();
  if (!mountRecord) return { success: false, error: '该资源未挂载到此团队' };

  const isFileOwner = file.userId === userId;
  const isTeamAdminOrOwner = membership.role === 'admin' || membership.role === 'owner';
  if (!isFileOwner && !isTeamAdminOrOwner) {
    return { success: false, error: '只有文件所有者或团队管理员可以卸载资源' };
  }

  // 1. 删除挂载记录
  await db.delete(teamResources).where(
    and(eq(teamResources.teamId, teamId), eq(teamResources.fileId, fileId))
  );

  // 2. ★ 同步清理关联的 file_permissions
  await db.delete(filePermissions).where(
    and(
      eq(filePermissions.fileId, fileId),
      eq(filePermissions.subjectType, 'team'),
      eq(filePermissions.teamId, teamId)
    )
  );

  // Activity
  await recordActivity(db, {
    teamId,
    userId,
    action: 'file_unmounted',
    resourceType: 'file',
    resourceId: fileId,
    details: { fileName: file.name },
  });

  logger.info('TeamService', '从团队卸载资源（含权限清理）', { userId, teamId, fileId });
  return { success: true, message: `文件 "${file.name}" 已从团队 "${team.name}" 卸载` };
}

// listTeamResources 保持原实现不变

// ─────────────────────────────────────────────────────────────────────────────
// ★ 新增：工作区文件列表
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 获取团队工作区的文件列表
 *
 * 逻辑:
 * 1. 查出团队所有已挂载的资源 (team_resources)
 * 2. 对每个资源，检查当前用户的最终有效权限
 * 3. 过滤掉无权访问的，返回有权限的文件列表
 * 4. 如果是文件夹，递归列出子文件
 */
export async function getTeamFiles(
  env: Env,
  teamId: string,
  viewerUserId: string,
  options?: { folderId?: string; limit?: number; offset?: number }
): Promise<{
  files: TeamFileItem[];
  total: number;
}> {
  const db = getDb(env.DB);
  const { folderId, limit = 50, offset = 0 } = options ?? {};

  // 1. 验证查看者是团队成员
  const membership = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, viewerUserId)))
    .get();
  if (!membership) return { files: [], total: 0 };

  // 2. 获取所有已挂载的资源 ID
  const mounts = await db
    .select({ fileId: teamResources.fileId, mountedAt: teamResources.mountedAt })
    .from(teamResources)
    .where(eq(teamResources.teamId, teamId))
    .all();

  if (mounts.length === 0) return { files: [], total: 0 };

  const mountedFileIds = mounts.map((m) => m.fileId);
  const mountedAtMap = new Map(mounts.map((m) => [m.fileId, m.mountedAt]));

  // 3. 查询这些文件的基本信息
  let fileQuery = db
    .select({
      id: files.id,
      name: files.name,
      path: files.path,
      type: files.type,
      mimeType: files.mimeType,
      size: files.size,
      isFolder: files.isFolder,
      parentId: files.parentId,
      deletedAt: files.deletedAt,
    })
    .from(files)
    .where(
      and(
        inArray(files.id, mountedFileIds),
        isNull(files.deletedAt)
      )
    );

  // 如果指定了 folderId，筛选该目录下的直接子项
  if (folderId) {
    fileQuery = fileQuery.where(eq(files.parentId, folderId));
  } else {
    // 只显示顶级（parentId 为空或在 team resources 中的根级文件）
    fileQuery = fileQuery.where(sql`(${files.parentId} IS NULL OR ${files.parentId} IN (${mountedFileIds}))`);
  }

  const allFiles = await fileQuery.all();

  // 4. 对每个文件检查当前用户权限
  const filesWithPerm: TeamFileItem[] = [];

  for (const file of allFiles) {
    // Owner 总是有权
    if (file.id && file.userId === viewerUserId) {
      filesWithPerm.push({
        fileId: file.id,
        fileName: file.name,
        filePath: file.path,
        fileType: file.type,
        mimeType: file.mimeType,
        size: file.size,
        isFolder: file.isFolder,
        mountedAt: mountedAtMap.get(file.id!) || '',
        permission: 'admin',
      });
      continue;
    }

    // 检查 file_permissions 中是否有针对 此用户 或 此团队 的授权
    const perm = await db
      .select({ permission: filePermissions.permission })
      .from(filePermissions)
      .where(
        and(
          eq(filePermissions.fileId, file.id!),
          or(
            and(eq(filePermissions.subjectType, 'user'), eq(filePermissions.userId, viewerUserId)),
            and(eq(filePermissions.subjectType, 'team'), eq(filePermissions.teamId, teamId))
          )!
        )
      )
      .get();

    if (perm) {
      filesWithPerm.push({
        fileId: file.id!,
        fileName: file.name,
        filePath: file.path,
        fileType: file.type,
        mimeType: file.mimeType,
        size: file.size,
        isFolder: file.isFolder,
        mountedAt: mountedAtMap.get(file.id!) || '',
        permission: perm.permission as 'read' | 'write' | 'admin',
      });
    }
  }

  // 5. 分页
  const total = filesWithPerm.length;
  const paged = filesWithPerm.slice(offset, offset + limit);

  return { files: paged, total };
}

// ─────────────────────────────────────────────────────────────────────────────
// ★ 新增：团队存储统计
// ─────────────────────────────────────────────────────────────────────────────

export async function getTeamStorageStats(
  db: DrizzleDb,
  teamId: string
): Promise<{ storageQuota: number; storageUsed: number; usagePercent: number; fileCount: number } | null {
  const team = await db.select().from(teams).where(eq(teams.id, teamId)).get();
  if (!team) return null;

  const quota = team.storageQuota ?? 5368709120;
  const used = team.storageUsed ?? 0;

  // 统计挂载的文件总数
  const resourceCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(teamResources)
    .where(eq(teamResources.teamId, teamId))
    .get();

  return {
    storageQuota: quota,
    storageUsed: used,
    usagePercent: quota > 0 ? Math.round((used / quota) * 10000) / 100 : 0,
    fileCount: Number(resourceCount?.count ?? 0),
  };
}
```

> **注意**: 上述代码中标记 `// ... 原实现不变 ...` 的部分需保留原文件中的原始函数体，不做改动。实际编辑时采用 SearchReplace 方式精确替换每个函数，而非整体覆写文件。

具体替换策略：
- `createTeam`: 替换函数体（增加 storageQuota/storageUsed/defaultMemberRole 字段 + activity 记录）
- `updateTeam`: 在成功分支末尾追加 activity 记录
- `manageTeamMembers`: 每个 case 分支的成功路径后追加 activity
- `mountResourceToTeam`: 在插入 teamResources 后追加 file_permissions 插入 + activity
- `unmountResourceFromTeam`: 在删除 teamResources 后追加 file_permissions 删除 + activity
- 文件末尾追加 `getTeamFiles` 和 `getTeamStorageStats` 两个新函数

- [ ] **Step 2: 验证编译通过**

Run: `cd apps/api && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/teamService.ts
git commit -m "feat(team): rewrite team service with workspace core, permission sync on mount"
```

---

### Task 5: 后端路由扩展 (teams.ts + invitations.ts)

**Files:**
- Modify: `apps/api/src/routes/teams.ts`
- Create: `apps/api/src/routes/invitations.ts`

- [ ] **Step 1: 扩展 teams.ts 路由**

在 `apps/api/src/routes/teams.ts` 中追加以下端点（在现有 `listTeamResources` 路由之后、`export default app` 之前）：

```typescript
// ═══════════════════════════════════════════════════════════════════════════
// 工作区文件浏览
// ═══════════════════════════════════════════════════════════════════════════

/** 获取团队工作区文件列表 */
app.get('/:id/workspace/files', async (c) => {
  const userId = c.get('userId')!;
  const teamId = c.req.param('id');
  const folderId = c.req.query('folderId') || undefined;
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  try {
    const result = await getTeamFiles(c.env, teamId, userId, { folderId, limit, offset });
    return c.json({ success: true, data: result });
  } catch (e: any) {
    throwAppError('WORKSPACE_ERROR', (e as Error).message || '获取工作区文件失败');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 邀请管理
// ═══════════════════════════════════════════════════════════════════════════

/** 创建邀请链接 */
app.post('/:id/invites', async (c) => {
  const userId = c.get('userId')!;
  const teamId = c.req.param('id');
  const body = await c.req.json();

  const createInviteSchema = z.object({
    role: z.enum(['member', 'guest']).default('member'),
    email: z.string().email('邮箱格式不正确').optional(),
    message: z.string().max(200).optional(),
    expiresInDays: z.number().min(1).max(30).default(7),
  });
  const parseResult = createInviteSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({
      success: false,
      error: { code: ERROR_CODES.VALIDATION_ERROR, message: parseResult.error.errors[0].message },
    }, 400);
  }

  const { createInvite } = await import('../lib/inviteService');
  const result = await createInvite(c.env, userId, {
    teamId,
    ...parseResult.data,
  });

  if (!result.success) {
    throwAppError('INVITE_CREATE_FAILED', (result as { error: string }).error);
  }

  await createAuditLog({
    env: c.env, userId,
    action: 'team.invite.create' as never,
    resourceType: 'team_invite',
    resourceId: teamId,
    details: parseResult.data,
    ipAddress: getClientIp(c),
    userAgent: getUserAgent(c),
  });

  return c.json({ success: true, data: (result as { invite: InviteInfo }).invite });
});

/** 列出待定邀请 */
app.get('/:id/invites', async (c) => {
  const userId = c.get('userId')!;
  const teamId = c.req.param('id');
  const db = getDb(c.env.DB);

  // 验证权限
  const membership = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .get();
  if (!membership || (membership.role !== 'admin' && membership.role !== 'owner')) {
    throwAppError('FORBIDDEN', '只有管理员可查看邀请列表');
  }

  const { listPendingInvites } = await import('../lib/inviteService');
  const invites = await listPendingInvites(db, teamId);
  return c.json({ success: true, data: { invites } });
});

/** 撤销邀请 */
app.delete('/:id/invites/:inviteId', async (c) => {
  const userId = c.get('userId')!;
  const teamId = c.req.param('id');
  const inviteId = c.req.param('inviteId');

  const { revokeInvite } = await import('../lib/inviteService');
  const result = await revokeInvite(c.env, teamId, inviteId, userId);
  if (!result.success) {
    throwAppError('INVITE_REVOKE_FAILED', (result as { error: string }).error);
  }

  return c.json({ success: true, data: { message: '邀请已撤销' } });
});

// 接受邀请（已登录用户通过 API 调用）
app.post('/:id/invites/:token/accept', async (c) => {
  const userId = c.get('userId')!;
  const teamId = c.req.param('id');
  const token = c.req.param('token');

  const { acceptInvite } = await import('../lib/inviteService');
  const result = await acceptInvite(c.env, token, userId);
  if (!result.success) {
    throwAppError('INVITE_ACCEPT_FAILED', (result as { error: string }).error);
  }

  return c.json({ success: true, data: result });
});

// ═══════════════════════════════════════════════════════════════════════════
// 团队活动流
// ═══════════════════════════════════════════════════════════════════════════

/** 获取团队活动时间线 */
app.get('/:id/activities', async (c) => {
  const userId = c.get('userId')!;
  const teamId = c.req.param('id');
  const db = getDb(c.env.DB);
  const limit = parseInt(c.req.query('limit') || '30', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  // 验证是成员
  const membership = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .get();
  if (!membership) {
    throwAppError('TEAM_ACCESS_DENIED', '您不是该团队成员');
  }

  const { listTeamActivities } = await import('../lib/teamActivityService');
  const result = await listTeamActivities(db, { teamId, limit, offset });
  return c.json({ success: true, data: result });
});

// ═══════════════════════════════════════════════════════════════════════════
// 存储统计
// ═══════════════════════════════════════════════════════════════════════════

/** 获取团队存储统计 */
app.get('/:id/storage', async (c) => {
  const userId = c.get('userId')!;
  const teamId = c.req.param('id');
  const db = getDb(c.env.DB);

  const membership = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .get();
  if (!membership) {
    throwAppError('TEAM_ACCESS_DENIED', '您不是该团队成员');
  }

  const { getTeamStorageStats } = await import('../lib/teamService');
  const stats = await getTeamStorageStats(db, teamId);
  if (!stats) throwAppError('TEAM_NOT_FOUND', '团队不存在');

  return c.json({ success: true, data: stats });
});
```

同时在文件头部 import 区域追加：

```typescript
import { getTeamFiles, getTeamStorageStats } from '../lib/teamService';
import type { InviteInfo } from '../lib/inviteService';
```

- [ ] **Step 2: 创建 invitations 公开路由**

创建 `apps/api/src/routes/invitations.ts`：

```typescript
/**
 * invitations.ts — 公开邀请路由（无需登录）
 *
 * 功能:
 * GET  /api/invite/:token  — 查看邀请详情（用于未登录时的落地页）
 * POST /api/invite/:token/accept — 接受邀请（需要登录态）
 * GET  /api/invite/code/:code — 通过短码查询邀请
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb, teamInvitations, teams, users } from '../db';
import { authMiddleware } from '../middleware/auth';
import { throwAppError } from '../middleware/error';
import type { Env, Variables } from '../types/env';

const publicApp = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── 公开端点：查看邀请详情（不需要登录）──

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

  if (!invite) {
    throwAppError('INVITE_NOT_FOUND', '邀请链接无效');
  }

  // 检查状态
  if (invite.status === 'accepted') {
    return c.json({ success: true, data: { ...invite, status: 'accepted', message: '此邀请已被接受' }});
  }
  if (invite.status === 'revoked') {
    return c.json({ success: true, data: { ...invite, status: 'revoked', message: '此邀请已被撤销' }});
  }
  if (invite.status === 'expired' || (invite.expiresAt && new Date(invite.expiresAt) < new Date())) {
    return c.json({ success: true, data: { ...invite, status: 'expired', message: '此邀请已过期' }});
  }

  return c.json({ success: true, data: { ...invite, status: 'pending' }});
});

// 通过短码查询
publicApp.get('/code/:code', async (c) => {
  const code = c.req.param('code');
  const db = getDb(c.env.DB);

  const invite = await db
    .select({ inviteToken: teamInvitations.inviteToken })
    .from(teamInvitations)
    .where(eq(teamInvitations.inviteCode, code))
    .get();

  if (!invite) {
    throwAppError('INVITE_NOT_FOUND', '邀请码无效');
  }

  // 重定向到 token 详情接口
  return c.redirect(`/api/invite/${invite.inviteToken}`);
});

// ── 受保护端点：接受邀请（需要登录）──

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
```

- [ ] **Step 3: 在主路由中注册 invitations 路由**

找到主路由注册文件（通常是 `apps/api/src/index.ts` 或 `apps/api/src/routes/index.ts`），追加：

```typescript
import { invitePublicRoutes, inviteProtectedRoutes } from './invitations';

// 公开邀请路由（无需登录）
app.route('/api/invite', invitePublicRoutes);
// 受保护的邀请操作
app.route('/api/invite', inviteProtectedRoutes);
```

- [ ] **Step 4: 验证编译通过**

Run: `cd apps/api && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/teams.ts apps/api/src/routes/invitations.ts
git commit -m "feat(team): add workspace/invite/activity/storage API endpoints"
```

---

### Task 6: 前端 API 服务层扩展

**Files:**
- Modify: `apps/web/src/services/collab.ts`

- [ ] **Step 1: 扩展 Team 类型定义**

在 `apps/web/src/services/collab.ts` 的 `Team` 接口中追加字段：

```typescript
export interface Team {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  settings: string;
  memberCount: number;
  userRole: string;
  isOwner: boolean;
  createdAt: string;
  updatedAt: string;
  // ── 新增 ─-
  storageQuota?: number;
  storageUsed?: number;
  defaultMemberRole?: string;
}
```

在文件末尾 `teamsApi` 对象之前追加新类型：

```typescript
/** 工作区文件条目 */
export interface WorkspaceFile {
  fileId: string;
  fileName: string;
  filePath: string | null;
  fileType: string | null;
  mimeType: string | null;
  size: number;
  isFolder: boolean;
  mountedAt: string;
  permission: 'read' | 'write' | 'admin';
}

/** 邀请信息 */
export interface TeamInvite {
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

/** 待定邀请条目 */
export interface PendingInvite {
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

/** 活动条目 */
export interface TeamActivity {
  id: string;
  userId: string;
  userName: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

/** 团队存储统计 */
export interface TeamStorageStats {
  storageQuota: number;
  storageUsed: number;
  usagePercent: number;
  fileCount: number;
}
```

- [ ] **Step 2: 扩展 teamsApi**

在 `teamsApi` 对象中追加新方法：

```typescript
export const teamsApi = {
  // ... 原有方法保持不变 ...

  // ── 工作区文件 ─-

  /** 获取团队工作区文件列表 */
  getWorkspaceFiles: (teamId: string, params?: { folderId?: string; limit?: number; offset?: number }) =>
    api.get<ApiResponse<{ files: WorkspaceFile[]; total: number }>>(
      `/api/teams/${teamId}/workspace/files`,
      { params: params ?? {} }
    ),

  // ── 邀请管理 ─-

  /** 创建邀请链接 */
  createInvite: (teamId: string, data: {
    role?: 'member' | 'guest';
    email?: string;
    message?: string;
    expiresInDays?: number;
  }) =>
    api.post<ApiResponse<TeamInvite>>(`/api/teams/${teamId}/invites`, data),

  /** 列出待定邀请 */
  listInvites: (teamId: string) =>
    api.get<ApiResponse<{ invites: PendingInvite[] }>>(`/api/teams/${teamId}/invites`),

  /** 撤销邀请 */
  revokeInvite: (teamId: string, inviteId: string) =>
    api.delete<ApiResponse<{ message: string }>>(`/api/teams/${teamId}/invites/${inviteId}`),

  /** 接受邀请 */
  acceptInvite: (teamId: string, token: string) =>
    api.post<ApiResponse<{ teamId: string; teamName: string; role: string }>>(
      `/api/teams/${teamId}/invites/${token}/accept`
    ),

  // ── 活动流 ─-

  /** 获取团队活动时间线 */
  getActivities: (teamId: string, params?: { limit?: number; offset?: number }) =>
    api.get<ApiResponse<{ items: TeamActivity[]; total: number }>>(
      `/api/teams/${teamId}/activities`,
      { params: params ?? {} }
    ),

  // ── 存储统计 ─-

  /** 获取团队存储统计 */
  getStorageStats: (teamId: string) =>
    api.get<ApiResponse<TeamStorageStats>>(`/api/teams/${teamId}/storage`),
};
```

- [ ] **Step 3: 验证构建通过**

Run: `cd apps/web && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/services/collab.ts
git commit -m "feat(web): extend collab service with workspace/invite/activity/storage APIs"
```

---

### Task 7: 团队工作区视图 (TeamWorkspace) — 核心前端组件

**Files:**
- Create: `apps/web/src/components/teams/TeamWorkspace.tsx`
- Create: `apps/web/src/pages/TeamWorkspace.tsx`

- [ ] **Step 1: 创建 TeamWorkspace.tsx**

创建 `apps/web/src/components/teams/TeamWorkspace.tsx`：

```tsx
/**
 * TeamWorkspace.tsx — 团队工作区文件浏览器
 *
 * 这是团队功能的核心差异化组件。
 * 它提供了一个独立的文件浏览视图，区别于个人 Files 页面：
 * - 显示的是团队挂载的所有资源聚合
 * - 每个文件标注来自哪个成员的共享
 * - 操作受限于团队内的权限级别
 * - 面包屑导航反映团队空间结构
 */

import React, { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/useToast';
import { teamsApi, type WorkspaceFile } from '@/services/collab';
import {
  ArrowLeft,
  FolderOpen,
  File,
  HardDrive,
  Users,
  Shield,
  Loader2,
  Grid,
  List,
  Upload,
  RefreshCw,
  Lock,
  Edit,
  Crown,
} from 'lucide-react';
import { cn, formatFileSize } from '@/utils';
import { BreadcrumbNav, type BreadcrumbItem } from '@/components/ui/BreadcrumbNav';
import { TeamStorageBar } from './TeamStorageBar';
import { TeamActivityFeed } from './TeamActivityFeed';
import type { ViewMode } from '@/stores/files';

interface TeamWorkspaceProps {
  teamId: string;
  teamName: string;
  userRole: string;
  isOwner: boolean;
}

type WorkspaceTab = 'files' | 'activity';

const TeamWorkspace: React.FC<TeamWorkspaceProps> = ({ teamId, teamName, userRole, isOwner }) => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('files');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [currentFolderId, setCurrentFolderId] = useState<string | undefined>();

  const { data: filesData, isLoading: isFilesLoading, refetch: refetchFiles } = useQuery({
    queryKey: ['team-workspace-files', teamId, currentFolderId],
    queryFn: () =>
      teamsApi.getWorkspaceFiles(teamId, { folderId: currentFolderId, limit: 100 }).then((r) => r.data.data),
  });

  const { data: storageData } = useQuery({
    queryKey: ['team-storage', teamId],
    queryFn: () => teamsApi.getStorageStats(teamId).then((r) => r.data.data),
  });

  const files = filesData?.files ?? [];
  const total = filesData?.total ?? 0;

  // 面包屑
  const breadcrumbs: BreadcrumbItem[] = [
    { label: '团队', onClick: () => navigate('/teams') },
    { label: teamName, onClick: () => setCurrentFolderId(undefined) },
    ...(currentFolderId ? [{ label: '文件夹' }] : []),
  ];

  // 进入文件夹
  const handleFolderClick = useCallback((file: WorkspaceFile) => {
    if (file.isFolder && file.permission !== 'read') {
      setCurrentFolderId(file.fileId);
    }
  }, []);

  // 权限图标
  const PermissionBadge = ({ permission }: { permission: string }) => {
    if (permission === 'admin') return <Crown className="h-3.5 w-3.5 text-purple-500" title="管理权限" />;
    if (permission === 'write') return <Edit className="h-3.5 w-3.5 text-blue-500" title="读写权限" />;
    return <Lock className="h-3.5 w-3.5 text-gray-400" title="只读权限" />;
  };

  return (
    <div className="space-y-4">
      {/* 头部 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/teams')}
            className="p-1.5 rounded-lg hover:bg-muted transition-colors"
            title="返回团队列表"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-semibold">{teamName}</h2>
              <span className="px-2 py-0.5 text-xs bg-primary/10 text-primary rounded-full flex items-center gap-1">
                <Users className="h-3 w-3" />
                工作区
              </span>
            </div>
            <BreadcrumbNav items={breadcrumbs} className="mt-1" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* 存储用量 */}
          {storageData && <TeamStorageStats stats={storageData} compact />}
          <Button variant="ghost" size="icon" onClick={() => refetchFiles()} title="刷新">
            <RefreshCw className={cn('h-4 w-4', isFilesLoading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* 存储条（展开版） */}
      {storageData && <TeamStorageBar stats={storageData} />}

      {/* Tab 切换 */}
      <div className="flex gap-1 border-b">
        {([
          { key: 'files' as WorkspaceTab, label: '文件', icon: <FolderOpen className="h-4 w-4" /> },
          { key: 'activity' as WorkspaceTab, label: '动态', icon: <Shield className="h-4 w-4" /> },
        ]).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors',
              activeTab === tab.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {tab.icon}
            {tab.label}
            {tab.key === 'files' && ` (${total})`}
          </button>
        ))}
      </div>

      {/* Tab 内容 */}
      {activeTab === 'files' && (
        <div className="space-y-3">
          {/* 工具栏 */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              <Button
                variant={viewMode === 'list' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setViewMode('list')}
              >
                <List className="h-4 w-4" />
              </Button>
              <Button
                variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setViewMode('grid')}
              >
                <Grid className="h-4 w-4" />
              </Button>
            </div>
            {(userRole === 'admin' || userRole === 'owner' || isOwner) && (
              <Button size="sm" disabled>
                <Upload className="h-4 w-4 mr-1" />
                上传文件（即将推出）
              </Button>
            )}
          </div>

          {/* 文件列表 */}
          {isFilesLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : files.length === 0 ? (
            <div className="text-center py-16 bg-muted/20 rounded-lg border border-dashed">
              <FolderOpen className="h-12 w-12 mx-auto text-muted-foreground/40 mb-3" />
              <p className="text-muted-foreground">工作区暂无文件</p>
              <p className="text-sm text-muted-foreground mt-1">
                团队管理员可以从个人空间挂载文件到这里
              </p>
            </div>
          ) : viewMode === 'list' ? (
            <div className="rounded-lg border overflow-hidden">
              {/* 表头 */}
              <div className="grid grid-cols-12 gap-2 px-4 py-2 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                <div className="col-span-6">名称</div>
                <div className="col-span-2">大小</div>
                <div className="col-span-2">权限</div>
                <div className="col-span-2">挂载时间</div>
              </div>
              {files.map((file) => (
                <div
                  key={file.fileId}
                  onClick={() => handleFolderClick(file)}
                  className={cn(
                    'grid grid-cols-12 gap-2 px-4 py-3 border-b last:border-b-0 hover:bg-muted/30 cursor-pointer transition-colors items-center',
                    file.isFolder && 'font-medium'
                  )}
                >
                  <div className="col-span-6 flex items-center gap-2 min-w-0">
                    {file.isFolder ? (
                      <FolderOpen className="h-4 w-4 text-blue-500 flex-shrink-0" />
                    ) : (
                      <File className="h-4 w-4 text-gray-400 flex-shrink-0" />
                    )}
                    <span className="truncate">{file.fileName}</span>
                  </div>
                  <div className="col-span-2 text-sm text-muted-foreground">
                    {file.isFolder ? '-' : formatFileSize(file.size)}
                  </div>
                  <div className="col-span-2">
                    <PermissionBadge permission={file.permission} />
                  </div>
                  <div className="col-span-2 text-xs text-muted-foreground">
                    {new Date(file.mountedAt).toLocaleDateString('zh-CN')}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            /* Grid 视图 */
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {files.map((file) => (
                <div
                  key={file.fileId}
                  onClick={() => handleFolderClick(file)}
                  className="flex flex-col items-center p-4 rounded-lg border hover:border-primary/50 hover:bg-muted/30 cursor-pointer transition-colors"
                >
                  {file.isFolder ? (
                    <FolderOpen className="h-10 w-10 text-blue-500 mb-2" />
                  ) : (
                    <File className="h-10 w-10 text-gray-400 mb-2" />
                  )}
                  <span className="text-sm text-center truncate w-full">{file.fileName}</span>
                  <PermissionBadge permission={file.permission} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'activity' && (
        <TeamActivityFeed teamId={teamId} />
      )}
    </div>
  );
};

// ── 紧凑型存储统计 ──

const TeamStorageStats: React.FC<{ stats: { usagePercent: number; storageQuota: number; storageUsed: number }; compact: boolean }> = ({
  stats,
  compact,
}) => (
  <div className={cn('flex items-center gap-1.5 text-xs', compact ? 'text-muted-foreground' : '')}>
    <HardDrive className="h-3.5 w-3.5" />
    <span>{stats.usagePercent}%</span>
  </div>
);

export default TeamWorkspace;
```

- [ ] **Step 2: 创建 TeamWorkspace 页面容器**

创建 `apps/web/src/pages/TeamWorkspace.tsx`：

```tsx
/**
 * TeamWorkspace.tsx — 团队工作区页面
 *
 * 路由: /teams/:teamId/workspace
 * 加载团队数据后渲染 TeamWorkspace 组件
 */

import React from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { teamsApi } from '@/services/collab';
import { Loader2 } from 'lucide-react';
import TeamWorkspace from '@/components/teams/TeamWorkspace';

const TeamWorkspacePage: React.FC = () => {
  const { teamId } = useParams<{ teamId: string }>();

  const { data: teamData, isLoading } = useQuery({
    queryKey: ['team', teamId],
    queryFn: () => teamsApi.get(teamId!).then((r) => r.data.data),
    enabled: !!teamId,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!teamData) {
    return <Navigate to="/teams" replace />;
  }

  return (
    <TeamWorkspace
      teamId={teamId!}
      teamName={teamData.name}
      userRole={teamData.userRole}
      isOwner={teamData.isOwner}
    />
  );
};

export default TeamWorkspacePage;
```

- [ ] **Step 3: 验证构建通过**

Run: `cd apps/web && npx tsc --noEmit`
Expected: 无错误（注意：TeamStorageBar 和 TeamActivityFeed 在 Task 8/9 创建前会报错，可在 Task 9 后统一验证）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/teams/TeamWorkspace.tsx apps/web/src/pages/TeamWorkspace.tsx
git commit -m "feat(web): add TeamWorkspace component - core collaborative file browser"
```

---

### Task 8: 邀请对话框 + 存储用量条 + 活动时间线

**Files:**
- Create: `apps/web/src/components/teams/TeamInviteDialog.tsx`
- Create: `apps/web/src/components/teams/TeamStorageBar.tsx`
- Create: `apps/web/src/components/teams/TeamActivityFeed.tsx`

- [ ] **Step 1: 创建 TeamInviteDialog.tsx**

```tsx
/**
 * TeamInviteDialog.tsx — 邀请成员对话框
 *
 * 两种模式:
 * 1. 生成邀请链接（复制分享）
 * 2. 指定邮箱发送邀请
 */

import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/useToast';
import { teamsApi, type PendingInvite } from '@/services/collab';
import { Loader2, X, Link, Mail, Copy, Check, Clock, Trash2, UserPlus } from 'lucide-react';
import { cn } from '@/utils';

interface TeamInviteDialogProps {
  teamId: string;
  teamName: string;
  onClose: () => void;
}

type InviteMode = 'link' | 'email';

const TeamInviteDialog: React.FC<TeamInviteDialogProps> = ({ teamId, teamName, onClose }) => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<InviteMode>('link');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [role, setRole] = useState<'member' | 'guest'>('member');
  const [copied, setCopied] = useState(false);
  const [createdInviteUrl, setCreatedInviteUrl] = useState<string | null>(null);
  const [createdInviteCode, setCreatedInviteCode] = useState<string | null>(null);

  // 已有的待定邀请列表
  const { data: pendingInvites } = useQuery({
    queryKey: ['team-invites', teamId],
    queryFn: () => teamsApi.listInvites(teamId).then((r) => r.data.data.invites),
    enabled: !!teamId,
  });

  // 创建邀请
  const createMutation = useMutation({
    mutationFn: () =>
      teamsApi.createInvite(teamId, {
        role,
        email: mode === 'email' ? email || undefined : undefined,
        message: message || undefined,
        expiresInDays: 7,
      }).then((r) => r.data.data),
    onSuccess: (data) => {
      setCreatedInviteUrl(data.inviteUrl);
      setCreatedInviteCode(data.inviteCode);
      toast({ title: mode === 'link' ? '邀请链接已生成' : '邀请已发送' });
      queryClient.invalidateQueries({ queryKey: ['team-invites', teamId] });
    },
    onError: (e: any) => {
      toast({ title: '创建失败', description: e.response?.data?.error?.message, variant: 'destructive' });
    },
  });

  // 撤销邀请
  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => teamsApi.revokeInvite(teamId, inviteId).then((r) => r.data),
    onSuccess: () => {
      toast({ title: '邀请已撤销' });
      queryClient.invalidateQueries({ queryKey: ['team-invites', teamId] });
    },
  });

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast({ title: '已复制到剪贴板' });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'email' && !email.trim()) {
      toast({ title: '请输入邮箱地址', variant: 'destructive' });
      return;
    }
    createMutation.mutate();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-card rounded-lg shadow-lg w-full max-w-lg mx-4 max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b flex-shrink-0">
          <div className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" />
            <h2 className="text-lg font-semibold">邀请成员 — {teamName}</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto flex-1">
          {/* 模式切换 */}
          <div className="flex gap-1 bg-muted rounded-lg p-1">
            <button
              onClick={() => setMode('link')}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                mode === 'link' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Link className="h-4 w-4" /> 邀请链接
            </button>
            <button
              onClick={() => setMode('email')}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                mode === 'email' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Mail className="h-4 w-4" /> 邮箱邀请
            </button>
          </div>

          {/* 已生成的链接结果 */}
          {createdInviteUrl && (
            <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-lg space-y-2">
              <p className="text-sm font-medium text-green-700 dark:text-green-400">邀请链接已生成</p>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={createdInviteUrl}
                  className="flex-1 text-xs bg-background border rounded px-2 py-1.5 font-mono truncate"
                />
                <Button variant="outline" size="sm" onClick={() => handleCopy(createdInviteUrl)}>
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </div>
              {createdInviteCode && (
                <p className="text-xs text-muted-foreground">
                  或使用邀请码：<span className="font-mono font-bold">{createdInviteCode}</span>
                </p>
              )}
              <p className="text-xs text-muted-foreground">链接 7 天内有效，仅限一次使用</p>
            </div>
          )}

          {/* 创建表单 */}
          {!createdInviteUrl && (
            <form onSubmit={handleSubmit} className="space-y-3">
              {mode === 'email' && (
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">邮箱地址</label>
                  <Input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="colleague@example.com"
                    type="email"
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-sm font-medium">默认角色</label>
                <div className="flex gap-2">
                  {([
                    { value: 'member' as const, label: '成员' },
                    { value: 'guest' as const, label: '访客' },
                  ]).map((r) => (
                    <button
                      key={r.value}
                      type="button"
                      onClick={() => setRole(r.value)}
                      className={cn(
                        'px-3 py-1.5 rounded-md text-sm border transition-colors',
                        role === r.value
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-muted hover:bg-muted'
                      )}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium">附言（可选）</label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="想对受邀者说点什么..."
                  className="w-full min-h-[60px] px-3 py-2 text-sm border rounded-md bg-background resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
                  maxLength={200}
                />
              </div>

              <Button type="submit" className="w-full" disabled={createMutation.isPending}>
                {createMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : mode === 'link' ? (
                  <Link className="h-4 w-4 mr-1" />
                ) : (
                  <Mail className="h-4 w-4 mr-1" />
                )}
                {mode === 'link' ? '生成邀请链接' : '发送邀请'}
              </Button>
            </form>
          )}

          {/* 已有待定邀请时显示列表 */}
          {pendingInvites && pendingInvites.length > 0 && (
            <div className="space-y-2 pt-2 border-t">
              <p className="text-sm font-medium text-muted-foreground">待接受的邀请 ({pendingInvites.length})</p>
              {pendingInvites.map((invite: PendingInvite) => (
                <div key={invite.id} className="flex items-center gap-3 p-2 rounded-lg bg-muted/30 text-sm">
                  <div className="flex-1 min-w-0">
                    <p className="truncate">
                      {invite.email || `邀请码: ${invite.inviteCode || '-'}`}
                    </p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>角色: {invite.role}</span>
                      {invite.expiresAt && (
                        <span className="flex items-center gap-0.5">
                          <Clock className="h-3 w-3" />
                          {new Date(invite.expiresAt).toLocaleDateString('zh-CN')}
                        </span>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive"
                    onClick={() => revokeMutation.mutate(invite.id)}
                    disabled={revokeMutation.isPending}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t flex justify-end flex-shrink-0">
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </div>
  );
};

export default TeamInviteDialog;
```

- [ ] **Step 2: 创建 TeamStorageBar.tsx**

```tsx
/**
 * TeamStorageBar.tsx — 团队存储用量可视化
 */

import React from 'react';
import { HardDrive } from 'lucide-react';
import { cn, formatFileSize } from '@/utils';
import type { TeamStorageStats } from '@/services/collab';

interface TeamStorageBarProps {
  stats: TeamStorageStats;
  compact?: boolean;
}

const TeamStorageBar: React.FC<TeamStorageBarProps> = ({ stats, compact = false }) => {
  const { storageQuota, storageUsed, usagePercent, fileCount } = stats;

  // 颜色根据使用率变化
  const barColor =
    usagePercent >= 90
      ? 'bg-red-500'
      : usagePercent >= 70
        ? 'bg-amber-500'
        : 'bg-green-500';

  if (compact) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <HardDrive className="h-3.5 w-3.5" />
        <span>{usagePercent}%</span>
        <div className="w-12 h-1.5 bg-muted rounded-full overflow-hidden">
          <div className={cn('h-full rounded-full transition-all', barColor)} style={{ width: `${Math.min(usagePercent, 100)}%` }} />
        </div>
      </div>
    );
  }

  return (
    <div className="p-3 rounded-lg border bg-muted/20 space-y-2">
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-1.5 font-medium">
          <HardDrive className="h-4 w-4" />
          团队存储空间
        </div>
        <span className="text-muted-foreground">
          {formatFileSize(storageUsed)} / {formatFileSize(storageQuota)}
        </span>
      </div>
      <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', barColor)}
          style={{ width: `${Math.min(usagePercent, 100)}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>已用 {usagePercent}%</span>
        <span>{fileCount} 个已挂载资源</span>
      </div>
    </div>
  );
};

export default TeamStorageBar;
```

- [ ] **Step 3: 创建 TeamActivityFeed.tsx**

```tsx
/**
 * TeamActivityFeed.tsx — 团队活动时间线
 */

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { teamsApi } from '@/services/collab';
import {
  UserPlus,
  UserMinus,
  Shield,
  FolderPlus,
  FolderMinus,
  Upload,
  Trash2,
  MessageSquare,
  Link as LinkIcon,
  Mail,
  Settings,
  Loader2,
  Clock,
} from 'lucide-react';
import { cn } from '@/utils';

interface TeamActivityFeedProps {
  teamId: string;
}

const ACTION_CONFIG: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  member_joined: { icon: <UserPlus className="h-4 w-4" />, color: 'text-green-500', label: '加入' },
  member_left: { icon: <UserMinus className="h-4 w-4" />, color: 'text-gray-400', label: '离开' },
  role_changed: { icon: <Shield className="h-4 w-4" />, color: 'text-amber-500', label: '角色变更' },
  file_mounted: { icon: <FolderPlus className="h-4 w-4" />, color: 'text-blue-500', label: '挂载文件' },
  file_unmounted: { icon: <FolderMinus className="h-4 w-4" />, color: 'text-orange-500', label: '卸载文件' },
  file_uploaded: { icon: <Upload className="h-4 w-4" />, color: 'text-cyan-500', label: '上传' },
  file_deleted: { icon: <Trash2 className="h-4 w-4" />, color: 'text-red-400', label: '删除' },
  comment_added: { icon: <MessageSquare className="h-4 w-4" />, color: 'text-purple-500', label: '评论' },
  team_created: { icon: <Settings className="h-4 w-4" />, color: 'text-primary', label: '创建团队' },
  team_settings_updated: { icon: <Settings className="h-4 w-4" />, color: 'text-gray-400', label: '更新设置' },
  invite_sent: { icon: <LinkIcon className="h-4 w-4" />, color: 'text-blue-400', label: '发送邀请' },
  invite_accepted: { icon: <Mail className="h-4 w-4" />, color: 'text-green-400', label: '接受邀请' },
};

const TeamActivityFeed: React.FC<TeamActivityFeedProps> = ({ teamId }) => {
  const { data: activityData, isLoading } = useQuery({
    queryKey: ['team-activities', teamId],
    queryFn: () => teamsApi.getActivities(teamId, { limit: 30 }).then((r) => r.data.data),
  });

  const items = activityData?.items ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground text-sm">
        <Clock className="h-8 w-8 mx-auto mb-2 opacity-40" />
        暂无活动记录
      </div>
    );
  }

  return (
    <div className="space-y-1 max-h-[500px] overflow-y-auto">
      {items.map((item) => {
        const config = ACTION_CONFIG[item.action] || {
          icon: <Clock className="h-4 w-4" />,
          color: 'text-gray-400',
          label: item.action,
        };

        return (
          <div
            key={item.id}
            className="flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-muted/30 transition-colors"
          >
            <div className={cn('mt-0.5 p-1.5 rounded-full bg-muted flex-shrink-0', config.color)}>
              {config.icon}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm">
                <span className="font-medium">{item.userName || '某人'}</span>
                {' '}
                <span className="text-muted-foreground">{config.label}</span>
                {item.details && Object.keys(item.details).length > 0 && (
                  <span className="text-muted-foreground">
                    {' '}
                    {formatDetail(item.action, item.details)}
                  </span>
                )}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {formatRelativeTime(item.createdAt)}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
};

function formatDetail(action: string, details: Record<string, unknown>): string {
  switch (action) {
    case 'member_joined':
      return `— 欢迎 ${(details.targetUserName as string) || '新成员'}`;
    case 'role_changed':
      return `→ ${(details.newRole as string) || ''}`;
    case 'file_mounted':
    case 'file_unmounted':
    case 'file_uploaded':
    case 'file_deleted':
      return `「${(details.fileName as string) || ''}」`;
    case 'invite_sent':
      return `→ ${(details.targetEmail as string) || (details.targetCode as string) || ''}`;
    default:
      return '';
  }
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  if (diffHour < 24) return `${diffHour} 小时前`;
  if (diffDay < 7) return `${diffDay} 天前`;
  return date.toLocaleDateString('zh-CN');
}

export default TeamActivityFeed;
```

- [ ] **Step 4: 验证构建通过**

Run: `cd apps/web && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/teams/TeamInviteDialog.tsx \
       apps/web/src/components/teams/TeamStorageBar.tsx \
       apps/web/src/components/teams/TeamActivityFeed.tsx
git commit -m "feat(web): add invite dialog, storage bar, and activity feed components"
```

---

### Task 9: 路由注册 + Teams 页面升级 + TeamList 增强

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/LazyComponents.tsx`
- Modify: `apps/web/src/pages/Teams.tsx`
- Modify: `apps/web/src/components/teams/TeamList.tsx`
- Modify: `apps/web/src/components/teams/TeamDetail.tsx`

- [ ] **Step 1: 注册新路由**

在 `apps/web/src/App.tsx` 中：

a) 将现有的 `/teams` 路由块替换为支持子路由的版本：

```tsx
// 将原来的:
// <Route path="/teams" element={...} />

// 替换为:
<Route path="/teams" element={
  <LazyWrapper>
    <LazyTeams />
  </LazyWrapper>
} />
<Route path="/teams/:teamId" element={
  <LazyWrapper>
    <LazyTeams />
  </LazyWrapper>
} />
<Route path="/teams/:teamId/workspace" element={
  <LazyWrapper>
    <LazyTeamWorkspace />
  </LazyWrapper>
} />
```

b) 在 LazyComponents.tsx 中新增:

```tsx
export const LazyTeamWorkspace = lazy(() =>
  import('./pages/TeamWorkspace').then((m) => ({ default: m.TeamWorkspacePage }))
);
```

并在 import 区域添加 `LazyTeamWorkspace` 到解构中。

- [ ] **Step 2: 升级 Teams.tsx 页面**

将 `apps/web/src/pages/Teams.tsx` 从简单的 TeamList 包装升级为支持两种模式的页面：

```tsx
/**
 * Teams.tsx — 团队中心页面 V2
 *
 * 路由:
 * - /teams       → 团队列表（默认）
 * - /teams/:id  → 团队详情（可进入工作区）
 */

import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { TeamList } from '@/components/teams';
import TeamDetail from '@/components/teams/TeamDetail';

const Teams: React.FC = () => {
  const { teamId } = useParams<{ teamId: string }>();
  const navigate = useNavigate();

  // 有 teamId 参数时显示详情面板（包含进入工作区入口）
  if (teamId) {
    return (
      <div className="space-y-6">
        <TeamDetail
          teamId={teamId}
          onClose={() => navigate('/teams')}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <TeamList />
    </div>
  );
};

export default Teams;
```

- [ ] **Step 3: 升级 TeamList 卡片 — 增加"进入工作区"按钮**

在 `apps/web/src/components/teams/TeamList.tsx` 的 `TeamCard` 组件中，操作按钮区域追加"进入工作区"按钮：

```tsx
// 在 TeamCard 的 <div className="flex items-center gap-2"> 中，
// 在"成员"按钮之前或之后添加：

<Button
  variant="ghost"
  size="sm"
  onClick={() => navigate(`/teams/${team.id}/workspace`)}
  title="进入工作区"
>
  <FolderOpen className="h-4 w-4 mr-1" />
  工作区
</Button>
```

需要导入 `useNavigate` 和 `FolderOpen` 图标。

同时在 TeamList 顶部引入 `useNavigate` hook。

- [ ] **Step 4: 升级 TeamDetail — 增加"活动"Tab + "进入工作区"入口**

在 `apps/web/src/components/teams/TeamDetail.tsx` 中：

a) tabs 数组增加活动 tab:
```tsx
{ key: 'activity', label: '动态', icon: <Clock className="h-4 w-4" /> },
```

b) 头部区域增加"进入工作区"按钮:
```tsx
<Button
  size="sm"
  variant="default"
  onClick={() => window.location.href = `/teams/${teamId}/workspace`}
  className="mt-2"
>
  <FolderOpen className="h-4 w-4 mr-1" />
  进入工作区
</Button>
```

c) activeTab === 'activity' 时渲染 `<TeamActivityFeed teamId={teamId} />`

d) 设置面板增加存储配额配置（仅 owner）

- [ ] **Step 5: 验证构建通过**

Run: `cd apps/web && npx tsc --noEmit && npm run build`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/LazyComponents.tsx \
       apps/web/src/pages/Teams.tsx \
       apps/web/src/components/teams/TeamList.tsx \
       apps/web/src/components/teams/TeamDetail.tsx
git commit -m "feat(web): upgrade Teams page with workspace routing and enhanced UI"
```

---

### Task 10: 集成测试 + 自检清单

**Files:**
- No new files — verification only

- [ ] **Step 1: 后端编译检查**

Run: `cd apps/api && npx tsc --noEmit`
Expected: 零错误

- [ ] **Step 2: 前端编译检查**

Run: `cd apps/web && npx tsc --noEmit`
Expected: 零错误

- [ ] **Step 3: 前端构建检查**

Run: `cd apps/web && npm run build`
Expected: 构建成功

- [ ] **Step 4: 功能自检清单**

逐项验证以下场景：

| # | 场景 | 预期行为 |
|---|------|----------|
| 1 | 访问 /teams | 显示团队列表，每张卡片有"进入工作区"按钮 |
| 2 | 点击"进入工作区" | 跳转到 /teams/:id/workspace，显示文件列表/动态两个 Tab |
| 3 | 工作区文件列表 | 显示团队所有已挂载资源，每行标注权限级别 |
| 4 | 点击团队卡片的"成员"按钮 | 弹出成员管理对话框（保持原有功能） |
| 5 | 点击团队卡片的"邀请"按钮 | 弹出邀请对话框（新模式），可生成链接/码 |
| 6 | 生成邀请链接 | 显示链接和短码，可一键复制 |
| 7 | 复制邀请链接并在新标签打开 | 显示邀请详情（公开接口） |
| 8 | 接受邀请（API 调用） | 用户被添加为团队成员 |
| 9 | 团队详情页 → 动态 Tab | 显示活动时间线 |
| 10 | 挂载文件到团队 | 自动同步创建 file_permissions（team 级别） |
| 11 | 卸载文件 | 自动清理关联的 file_permissions |
| 12 | 添加/移除成员 | 自动产生活动记录 |
| 13 | 存储用量条 | 正确显示百分比和容量 |

- [ ] **Step 5: 最终 Commit（如有遗漏修复）**

```bash
git add -A
git commit -m "fix(team): address integration test findings"
```

---

## 实施顺序依赖关系

```
Task 1 (DB Schema)
  ↓
Task 2 (InviteService) ←→ Task 3 (ActivityService)  ← 可并行
  ↓                              ↓
Task 4 (teamService Rewrite) ← 需两者完成
  ↓
Task 5 (Backend Routes) ← 需要 Task 2+3+4
  ↓
Task 6 (Frontend API Layer) ← 需要 Task 5 的接口定义
  ↓
Task 7 (TeamWorkspace Component) ←← Task 8 (UI Components) ← 可并行
  ↓                              ↓
Task 9 (Routing + Page Upgrade) ← 需要 Task 7+8
  ↓
Task 10 (Integration Test)
```

预计总任务数：10 个 Task，其中 Task 2/3 可并行，Task 7/8 可并行。
