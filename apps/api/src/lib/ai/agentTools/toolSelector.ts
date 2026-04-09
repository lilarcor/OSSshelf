/**
 * toolSelector.ts
 * 工具集动态裁剪模块
 *
 * 功能:
 * - 按意图分组工具
 * - 根据查询意图选择最小工具子集
 * - 检测写操作意图
 *
 * 目的:
 * - 减少注入 LLM 的 token 数量（从 83 个工具降到约 20 个）
 * - 提高 LLM 工具选择准确率
 */

// 工具分组定义
export const TOOL_GROUPS = {
  search: [
    'search_files',
    'filter_files',
    'search_by_tag',
    'search_duplicates',
    'smart_search',
    'get_similar_files',
    'get_file_details',
  ],
  content: [
    'read_file_text',
    'analyze_image',
    'compare_files',
    'content_preview',
    'extract_metadata',
    'generate_summary',
    'generate_tags',
  ],
  nav: [
    'list_folder',
    'get_folder_tree',
    'navigate_path',
    'get_storage_overview',
    'get_recent_files',
    'get_starred_files',
    'get_parent_chain',
  ],
  stats: [
    'get_storage_stats',
    'get_activity_stats',
    'get_user_quota_info',
    'get_file_type_distribution',
    'get_sharing_stats',
  ],
  write: [
    'create_text_file',
    'create_code_file',
    'create_file_from_template',
    'edit_file_content',
    'append_to_file',
    'find_and_replace',
    'rename_file',
    'move_file',
    'copy_file',
    'delete_file',
    'restore_file',
    'create_folder',
    'batch_rename',
    'star_file',
    'unstar_file',
  ],
  tags: [
    'add_tag',
    'remove_tag',
    'get_file_tags',
    'merge_tags',
    'auto_tag_files',
    'tag_folder',
    'list_all_tags_for_management',
  ],
  share: [
    'create_share_link',
    'list_shares',
    'update_share_settings',
    'revoke_share',
    'get_share_stats',
    'create_direct_link',
    'revoke_direct_link',
    'create_upload_link_for_folder',
  ],
  version: ['get_file_versions', 'restore_version', 'compare_versions', 'set_version_retention'],
  notes: ['add_note', 'get_notes', 'update_note', 'delete_note', 'search_notes'],
  system: [
    'get_system_status',
    'get_help',
    'get_version_info',
    'get_faq',
    'get_user_profile',
    'list_api_keys',
    'create_api_key',
    'revoke_api_key',
    'list_webhooks',
    'create_webhook',
    'get_audit_logs',
  ],
  storage: [
    'get_storage_usage',
    'get_large_files',
    'get_folder_sizes',
    'get_cleanup_suggestions',
    'list_buckets',
    'get_bucket_info',
    'set_default_bucket',
    'migrate_file_to_bucket',
  ],
  permission: [
    'get_file_permissions',
    'grant_permission',
    'revoke_permission',
    'set_folder_access_level',
    'list_user_groups',
    'manage_group_members',
  ],
  ai_enhance: [
    'trigger_ai_summary',
    'trigger_ai_tags',
    'rebuild_vector_index',
    'ask_rag_question',
    'smart_rename_suggest',
  ],
} as const;

// 写意图检测模式（中英文）
const WRITE_INTENT_PATTERNS =
  /创建|新建|编辑|修改|删除|移动|重命名|复制|打标|分享|备注|写入|添加|移除|撤销|恢复|create|edit|delete|move|rename|copy|share|add|remove|write/;

/**
 * 检测是否需要写操作工具
 */
export function needsWriteTools(query: string): boolean {
  return WRITE_INTENT_PATTERNS.test(query);
}

/**
 * 根据意图选择工具名称集合
 */
export function selectTools(intent: string, query: string): string[] {
  const base = [...TOOL_GROUPS.search, ...TOOL_GROUPS.nav];

  switch (intent) {
    case 'file_stats':
      return [...base, ...TOOL_GROUPS.stats];
    case 'image_visual':
      return [...base, ...TOOL_GROUPS.content];
    case 'content_qa':
      return [...base, ...TOOL_GROUPS.content, ...TOOL_GROUPS.notes];
    case 'file_search':
      return [...base, ...TOOL_GROUPS.content];
    default:
      return [...base, ...TOOL_GROUPS.stats, ...TOOL_GROUPS.system];
  }
}

/**
 * 获取完整工具集名称列表（用于调试或特殊场景）
 */
export function getAllToolNames(): string[] {
  return Object.values(TOOL_GROUPS).flat();
}

/**
 * 获取工具分组信息（用于调试）
 */
export function getToolGroupNames(): string[] {
  return Object.keys(TOOL_GROUPS);
}
