/**
 * Teams.tsx — 团队中心页面 V2
 *
 * 路由:
 * - /teams       → 团队列表（默认）
 * - /teams/:id   → 团队详情面板（含进入工作区入口）
 */

import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { TeamList } from '@/components/teams';
import TeamDetail from '@/components/teams/TeamDetail';

const Teams: React.FC = () => {
  const { teamId } = useParams<{ teamId: string }>();
  const navigate = useNavigate();

  if (teamId) {
    return (
      <div className="space-y-6">
        <TeamDetail teamId={teamId} onClose={() => navigate('/teams')} />
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
