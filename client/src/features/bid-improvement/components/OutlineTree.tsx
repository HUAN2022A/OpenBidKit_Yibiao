import { useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from 'react';

/**
 * 目录树节点（简化结构，与 bidImprovementService 提取的目录树同构）。
 * 叶子节点带 content，分支节点带 children。
 */
export interface OutlineTreeNode {
  id: string;
  title: string;
  content?: string;
  children?: OutlineTreeNode[];
}

export interface OutlineTreeProps {
  /** 顶层节点数组 */
  items: OutlineTreeNode[];
  /** 当前选中的节点 id 列表（受控，支持多选） */
  selectedIds: string[];
  /** 选中变化回调；父组件据此在右侧展示选中节点内容 */
  onSelectionChange: (ids: string[]) => void;
  /** 初始展开的节点 id；省略时默认展开所有含子节点的分支（仅首次挂载生效） */
  initialExpandedIds?: string[];
  /** 空状态文案 */
  emptyText?: string;
  /** 附加到列表容器上的 class */
  className?: string;
}

/** 按展示顺序（深度优先）拍平所有节点 id，供 Shift 区间选择使用。 */
function flattenIds(items: OutlineTreeNode[]): string[] {
  const ids: string[] = [];
  const visit = (list: OutlineTreeNode[]) => {
    for (const node of list) {
      ids.push(node.id);
      if (node.children?.length) {
        visit(node.children);
      }
    }
  };
  visit(items);
  return ids;
}

/** 收集所有含子节点的分支 id，作为默认展开集合。 */
function collectBranchIds(items: OutlineTreeNode[]): Set<string> {
  const ids = new Set<string>();
  const visit = (list: OutlineTreeNode[]) => {
    for (const node of list) {
      if (node.children?.length) {
        ids.add(node.id);
        visit(node.children);
      }
    }
  };
  visit(items);
  return ids;
}

function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}

function OutlineTree({
  items,
  selectedIds,
  onSelectionChange,
  initialExpandedIds,
  emptyText = '暂无目录',
  className,
}: OutlineTreeProps) {
  const flattened = useMemo(() => flattenIds(items), [items]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const anchorIndexRef = useRef<number | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => (initialExpandedIds ? new Set(initialExpandedIds) : collectBranchIds(items)),
  );

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleNodeClick = (event: ReactMouseEvent, id: string) => {
    const index = flattened.indexOf(id);
    if (index < 0) {
      return;
    }
    const additive = event.ctrlKey || event.metaKey;

    if (event.shiftKey && anchorIndexRef.current !== null) {
      const start = Math.min(anchorIndexRef.current, index);
      const end = Math.max(anchorIndexRef.current, index);
      const range = flattened.slice(start, end + 1);
      if (additive) {
        const base = new Set(selectedIds);
        range.forEach((rangeId) => base.add(rangeId));
        onSelectionChange(flattened.filter((flatId) => base.has(flatId)));
      } else {
        onSelectionChange(range);
      }
      // Shift 区间选择不移动锚点，方便连续扩展区间。
      return;
    }

    if (additive) {
      onSelectionChange(toggleId(selectedIds, id));
    } else {
      onSelectionChange([id]);
    }
    anchorIndexRef.current = index;
  };

  const renderNode = (node: OutlineTreeNode, depth: number): ReactNode => {
    const hasChildren = Boolean(node.children?.length);
    const isExpanded = expandedIds.has(node.id);
    const isSelected = selectedSet.has(node.id);

    return (
      <div className="bid-tree-node" key={node.id} style={{ '--bid-tree-level': depth } as CSSProperties}>
        <div className={`bid-tree-item${isSelected ? ' is-selected' : ''}`}>
          <button
            type="button"
            className={`bid-tree-toggle${hasChildren ? '' : ' is-leaf'}${isExpanded ? ' is-expanded' : ''}`}
            onClick={() => hasChildren && toggleExpanded(node.id)}
            disabled={!hasChildren}
            aria-expanded={hasChildren ? isExpanded : undefined}
            aria-label={hasChildren ? `${isExpanded ? '折叠' : '展开'} ${node.title}` : `${node.title} 无子节点`}
          >
            {hasChildren ? '›' : '•'}
          </button>
          <button
            type="button"
            className="bid-tree-content"
            onClick={(event) => handleNodeClick(event, node.id)}
            onDoubleClick={() => hasChildren && toggleExpanded(node.id)}
            aria-selected={isSelected}
            title={node.title}
          >
            <span className="bid-tree-title">{node.title}</span>
          </button>
        </div>
        {hasChildren && isExpanded && node.children!.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  if (!items.length) {
    return <div className={`bid-tree-empty${className ? ` ${className}` : ''}`}>{emptyText}</div>;
  }

  return (
    <div className={`bid-tree-list${className ? ` ${className}` : ''}`}>
      {items.map((item) => renderNode(item, 0))}
    </div>
  );
}

export default OutlineTree;
