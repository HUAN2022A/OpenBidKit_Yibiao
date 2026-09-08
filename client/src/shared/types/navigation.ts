export type SectionId =
  | 'home'
  | 'prepare'
  | 'generate'
  | 'review'
  | 'export'
  | 'technical-plan'
  | 'existing-plan-expansion'
  | 'feasibility-report'
  | 'business-bid'
  | 'document-knowledge-base'
  | 'image-knowledge-base'
  | 'resources'
  | 'duplicate-check'
  | 'rejection-check'
  | 'ai-evaluation'
  | 'my-templates'
  | 'new-template'
  | 'export-format'
  | 'bid-opportunity'
  | 'developer-test'
  | 'developer-json-test'
  | 'developer-multimodal-test'
  | 'developer-prompt-lab'
  | 'developer-parser-sandbox'
  | 'developer-export-preview'
  | 'developer-expansion-replace-test'
  | 'developer-agent-test'
  | 'settings'
  | 'plugin-manager';

export interface AppMenuNotice {
  message: string;
  actionLabel?: string;
  externalUrl?: string;
}

export interface AppSubMenuItem {
  id: SectionId;
  label: string;
  description: string;
  icon?: 'document' | 'expand' | 'briefcase' | 'compare' | 'shield' | 'code' | 'prompt' | 'file' | 'export' | 'tool' | 'radar' | 'home';
  badge?: string;
  notice?: AppMenuNotice;
}

export interface AppMenuItem {
  id: SectionId;
  label: string;
  description: string;
  children?: AppSubMenuItem[];
  notice?: AppMenuNotice;
}
