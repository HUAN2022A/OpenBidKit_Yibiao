import * as Tooltip from '@radix-ui/react-tooltip';
import type { ReactNode, SVGProps } from 'react';
import AgentRuntimeStatusBar from '../app/AgentRuntimeStatusBar';
import { getParentMenuItemBySection } from '../app/menuConfig';
import type { SectionId } from '../shared/types/navigation';
import Sidebar from './Sidebar';

interface AppShellProps {
  activeSection: SectionId;
  children: ReactNode;
  developerMode: boolean;
  onSectionChange: (section: SectionId) => void;
}

function AppShell({ activeSection, children, developerMode, onSectionChange }: AppShellProps) {
  const isMac = navigator.platform.toLowerCase().includes('mac');
  const activeParent = getParentMenuItemBySection(activeSection, developerMode);
  const currentLabel =
    activeParent == null
      ? activeSection === 'settings'
        ? '设置'
        : undefined
      : activeParent.id === activeSection
        ? activeParent.label
        : activeParent.children?.find((child) => child.id === activeSection)?.label ?? activeParent.label;
  const parentLabel = activeParent != null && activeParent.id !== activeSection ? activeParent.label : undefined;

  return (
    <Tooltip.Provider delayDuration={120} skipDelayDuration={80}>
      <div className={`app-shell${isMac ? ' is-mac' : ''}`}>
        <Sidebar activeSection={activeSection} developerMode={developerMode} onSectionChange={onSectionChange} />

        <main className="main-area">
          <header className="app-topbar">
            <div className="app-topbar-left">
              <div className="app-topbar-brand">
                <span className="app-topbar-brand-mark" aria-hidden="true">
                  铸
                </span>
                <span className="app-topbar-brand-name">铸标</span>
              </div>
              {currentLabel != null && (
                <nav className="app-topbar-breadcrumb" aria-label="当前位置">
                  {parentLabel != null && <span className="app-topbar-breadcrumb-parent">{parentLabel}</span>}
                  {parentLabel != null && <span className="app-topbar-breadcrumb-sep" aria-hidden="true">/</span>}
                  <span className="app-topbar-breadcrumb-current">{currentLabel}</span>
                </nav>
              )}
            </div>

            <div className="app-topbar-search">
              <SearchIcon />
              <input type="text" placeholder="搜索功能、模板、素材…" aria-label="搜索功能、模板、素材" />
            </div>

            <button
              type="button"
              className={`app-topbar-settings${activeSection === 'settings' ? ' is-active' : ''}`}
              onClick={() => onSectionChange('settings')}
              aria-label="设置"
              aria-current={activeSection === 'settings' ? 'page' : undefined}
            >
              <GearIcon />
            </button>
          </header>

          <AgentRuntimeStatusBar />
          <section className="content-shell" aria-label="主内容">
            {children}
          </section>
        </main>
      </div>
    </Tooltip.Provider>
  );
}

function SearchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function GearIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z" />
      <path d="m19.1 13.5.1-1.5-.1-1.5 2-1.5-2-3.4-2.45.95a8.2 8.2 0 0 0-2.55-1.45L13.75 2h-3.5L9.9 5.1a8.2 8.2 0 0 0-2.55 1.45L4.9 5.6l-2 3.4 2 1.5L4.8 12l.1 1.5-2 1.5 2 3.4 2.45-.95A8.2 8.2 0 0 0 9.9 18.9l.35 3.1h3.5l.35-3.1a8.2 8.2 0 0 0 2.55-1.45l2.45.95 2-3.4z" />
    </svg>
  );
}

export default AppShell;
