import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import { trackPageView } from '../../../shared/analytics/analytics';
import { setPendingKnowledgeDocument } from '../../../shared/navigationIntent';
import type { KnowledgeBaseImageItem, KnowledgeBaseListImageItemsPage } from '../../../shared/types/ipc';
import { EmptyState, InlineSpinner, useToast } from '../../../shared/ui';

/** image_type 筛选档位：全部 + 常用配图类型（与配图规划词汇表一致） */
const imageTypeOptions = ['工程图示', '实景照片', '流程图', '层级图', '职责关系图'] as const;

const keywordDebounceMs = 300;

interface ImageKnowledgeBasePageProps {
  onSectionChange: (section: string) => void;
}

function ImageKnowledgeBasePage({ onSectionChange }: ImageKnowledgeBasePageProps) {
  const { showToast } = useToast();
  const [keyword, setKeyword] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const [imageType, setImageType] = useState('');
  const [page, setPage] = useState(1);
  const [resultPage, setResultPage] = useState<KnowledgeBaseListImageItemsPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    trackPageView('image-knowledge-base');
  }, []);

  // 关键词输入防抖后重查，并回到第一页。
  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const nextKeyword = keyword.trim();
      setAppliedKeyword((current) => (current === nextKeyword ? current : nextKeyword));
      setPage(1);
    }, keywordDebounceMs);
    return () => window.clearTimeout(timeoutId);
  }, [keyword]);

  // 查询条件变化时拉取当前页（竞态用 requestId 丢弃过期响应）。
  useEffect(() => {
    const knowledgeApi = window.yibiao?.knowledgeBase;
    if (!knowledgeApi) return;
    const requestId = ++requestIdRef.current;
    setError('');
    setLoading(true);
    knowledgeApi
      .listImageItems({ keyword: appliedKeyword, imageType, page })
      .then((result) => {
        if (requestIdRef.current !== requestId) return;
        setResultPage(result);
      })
      .catch((loadError) => {
        if (requestIdRef.current !== requestId) return;
        const message = loadError instanceof Error ? loadError.message : '读取图片知识库失败';
        setError(message);
        setResultPage(null);
        showToast(message, 'error');
      })
      .finally(() => {
        if (requestIdRef.current === requestId) setLoading(false);
      });
    // showToast 引用稳定（ToastProvider useCallback），无需纳入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedKeyword, imageType, page]);

  const handleImageTypeChange = (nextType: string) => {
    setImageType((current) => (current === nextType ? current : nextType));
    setPage(1);
  };

  const openSourceDocument = (item: KnowledgeBaseImageItem) => {
    setPendingKnowledgeDocument(item.document_id);
    onSectionChange('document-knowledge-base');
  };

  const openImagePreview = (item: KnowledgeBaseImageItem) => {
    if (!item.asset_url) return;
    setPreviewImage({ src: item.asset_url, alt: item.title || '图片预览' });
  };

  const items = resultPage?.items || [];
  const totalPages = resultPage ? Math.max(1, Math.ceil(resultPage.total / resultPage.pageSize)) : 1;

  return (
    <>
      <div className="page-stack image-kb-page">
        <section className="image-kb-workspace-bar">
          <div className="image-kb-breadcrumb">
            <span>知识库</span>
            <strong>图片知识库</strong>
            <small>{resultPage ? `共 ${resultPage.total} 张图片` : '管理图片素材、图示和视觉参考资料'}</small>
          </div>
        </section>

        <section className="panel image-kb-toolbar" aria-label="图片筛选">
          <div className="image-kb-toolbar-row">
            <label htmlFor="image-kb-keyword-input">关键词</label>
            <input
              id="image-kb-keyword-input"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="输入图片标题或摘要关键字"
            />
            {loading && <InlineSpinner />}
          </div>
          <div className="image-kb-filter-chips" role="group" aria-label="图片类型筛选">
            <button
              type="button"
              className={`image-kb-chip${imageType === '' ? ' is-active' : ''}`}
              onClick={() => handleImageTypeChange('')}
            >
              全部
            </button>
            {imageTypeOptions.map((option) => (
              <button
                key={option}
                type="button"
                className={`image-kb-chip${imageType === option ? ' is-active' : ''}`}
                onClick={() => handleImageTypeChange(option)}
              >
                {option}
              </button>
            ))}
          </div>
        </section>

        <main className="panel image-kb-grid-panel">
          {loading && !resultPage ? (
            <div className="image-kb-status-box">
              <InlineSpinner />
              <strong>正在读取图片...</strong>
              <p>图片较多时需要稍等片刻。</p>
            </div>
          ) : error && !resultPage ? (
            <div className="image-kb-status-box">
              <strong>图片知识库读取失败</strong>
              <p role="alert">{error}</p>
            </div>
          ) : items.length ? (
            <div className="image-kb-grid">
              {items.map((item) => (
                <ImageKnowledgeCard
                  key={item.item_id}
                  item={item}
                  onOpenPreview={openImagePreview}
                  onOpenSource={openSourceDocument}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              title="暂无图片，请到文档知识库上传含图文档解析"
              hint={appliedKeyword || imageType ? '可以尝试更换关键词或图片类型。' : '文档解析完成后，其中的图片会自动收录到这里。'}
            />
          )}
        </main>

        {resultPage && resultPage.total > 0 && (
          <div className="image-kb-pagination">
            <span>
              第 {resultPage.page} / {totalPages} 页 · 当前显示 {(resultPage.page - 1) * resultPage.pageSize + 1}–{(resultPage.page - 1) * resultPage.pageSize + items.length} 条
            </span>
            <div>
              <button type="button" className="secondary-action" disabled={loading || resultPage.page <= 1} onClick={() => setPage(resultPage.page - 1)}>上一页</button>
              <button type="button" className="secondary-action" disabled={loading || resultPage.page >= totalPages} onClick={() => setPage(resultPage.page + 1)}>下一页</button>
            </div>
          </div>
        )}
      </div>

      <Dialog.Root open={Boolean(previewImage)} onOpenChange={(open) => !open && setPreviewImage(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="image-preview-modal" />
          <Dialog.Content className="image-preview-card">
            <Dialog.Close className="image-preview-close" type="button" aria-label="关闭图片预览">×</Dialog.Close>
            <Dialog.Title>{previewImage?.alt || '图片预览'}</Dialog.Title>
            {previewImage ? <img src={previewImage.src} alt={previewImage.alt} /> : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

interface ImageKnowledgeCardProps {
  item: KnowledgeBaseImageItem;
  onOpenPreview: (item: KnowledgeBaseImageItem) => void;
  onOpenSource: (item: KnowledgeBaseImageItem) => void;
}

function ImageKnowledgeCard({ item, onOpenPreview, onOpenSource }: ImageKnowledgeCardProps) {
  return (
    <article className="image-kb-card">
      <button
        type="button"
        className="image-kb-card-thumb"
        title="点击放大查看"
        aria-label={`放大查看图片：${item.title}`}
        onClick={() => onOpenPreview(item)}
      >
        <img src={item.asset_url} alt={item.title} loading="lazy" decoding="async" />
      </button>
      <div className="image-kb-card-body">
        <div className="image-kb-card-tags">
          <span className="image-kb-kind-tag">图片条目</span>
          {item.image_type && <span className="image-kb-type-tag">{item.image_type}</span>}
        </div>
        <strong className="image-kb-card-title" title={item.title}>{item.title}</strong>
        {item.resume && <p className="image-kb-card-resume">{item.resume}</p>}
        <div className="image-kb-card-source">
          <span>来源文档</span>
          <strong title={item.file_name}>{item.file_name}</strong>
          {item.folder_name && <small>{item.folder_name}</small>}
          {formatUpdatedAt(item.updated_at) && <time dateTime={item.updated_at}>{formatUpdatedAt(item.updated_at)}</time>}
        </div>
      </div>
      <div className="image-kb-card-actions">
        <button type="button" className="secondary-action" onClick={() => onOpenSource(item)}>查看原文</button>
      </div>
    </article>
  );
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

export default ImageKnowledgeBasePage;
