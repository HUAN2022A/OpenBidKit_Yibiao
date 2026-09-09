export type SectionId =
  | 'bid-generation'
  | 'technical-plan'
  | 'existing-plan-expansion'
  | 'feasibility-report'
  | 'knowledge-base'
  | 'document-knowledge-base'
  | 'image-knowledge-base'
  | 'bid-check'
  | 'duplicate-check'
  | 'rejection-check'
  | 'ai-evaluation'
  | 'template-settings'
  | 'my-templates'
  | 'new-template'
  | 'export-format'
  | 'bid-opportunity'
  | 'bid-opportunity-discovery'
  | 'bid-opportunity-price'
  | 'bid-opportunity-enterprise'
  | 'developer-test'
  | 'developer-json-test'
  | 'developer-multimodal-test'
  | 'developer-prompt-lab'
  | 'developer-parser-sandbox'
  | 'developer-export-preview'
  | 'developer-expansion-replace-test'
  | 'developer-agent-test'
  | 'settings';

export interface AppSubMenuItem {
  id: SectionId;
  label: string;
  description: string;
  icon?: 'document' | 'expand' | 'briefcase' | 'compare' | 'shield' | 'code' | 'prompt' | 'file' | 'export' | 'tool';
  badge?: string;
}

export interface AppMenuItem {
  id: SectionId;
  label: string;
  description: string;
  children?: AppSubMenuItem[];
}
