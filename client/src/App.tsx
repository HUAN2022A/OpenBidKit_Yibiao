import { useEffect, useRef, useState } from 'react';
import AppRouter from './app/AppRouter';
import GpuHardwareAccelerationPrompt from './app/GpuHardwareAccelerationPrompt';
import LicenseStatusPrompt from './app/LicenseStatusPrompt';
import RequiredOnlineServicesPrompt from './app/RequiredOnlineServicesPrompt';
import UpdateNotifier from './app/UpdateNotifier';
import AppShell from './components/AppShell';
import { trackAppOpen, trackConfigUsage, trackPageView } from './shared/analytics/analytics';
import type { SectionId } from './shared/types/navigation';

function isDeveloperSection(section: SectionId) {
  return section.startsWith('developer-');
}

function isManagedWorkbenchSection(section: SectionId) {
  return section === 'technical-plan' || section === 'existing-plan-expansion' || section === 'feasibility-report';
}

function App() {
  const [activeSection, setActiveSection] = useState<SectionId>('bid-generation');
  const [developerMode, setDeveloperMode] = useState(false);
  const [productionMode, setProductionMode] = useState(false);
  const leaveGuardRef = useRef<((nextSection?: string) => Promise<boolean>) | null>(null);

  useEffect(() => {
    trackAppOpen();

    void window.yibiao?.config.load()
      .then((config) => {
        setDeveloperMode(Boolean(config?.developer_mode));
        setProductionMode(Boolean(config?.production_mode));
        trackConfigUsage({}, config);
      })
      .catch((error) => console.warn('读取开发者模式失败', error));
  }, []);

  useEffect(() => {
    trackPageView(activeSection);
    if (isManagedWorkbenchSection(activeSection)) return;
    void window.yibiao?.ui?.setCurrentView({ section: activeSection });
  }, [activeSection]);

  useEffect(() => {
    if (!developerMode && isDeveloperSection(activeSection)) {
      setActiveSection('bid-generation');
    }
  }, [activeSection, developerMode]);

  useEffect(() => {
    // 生产模式下，如果当前页面不在允许列表中，跳转到默认页面
    if (productionMode) {
      const allowedSections: SectionId[] = [
        'existing-plan-expansion',
        'bid-check',
        'duplicate-check',
        'rejection-check',
        'knowledge-base',
        'document-knowledge-base',
        'template-settings',
        'my-templates',
        'new-template',
        'settings',
      ];
      if (!allowedSections.includes(activeSection)) {
        setActiveSection('existing-plan-expansion');
      }
    }
  }, [activeSection, productionMode]);

  const requestSectionChange = async (section: SectionId) => {
    if (section === activeSection) {
      return;
    }
    const allowed = await (leaveGuardRef.current?.(section) ?? Promise.resolve(true));
    if (allowed) {
      setActiveSection(section);
    }
  };

  return (
    <>
      <GpuHardwareAccelerationPrompt />
      <RequiredOnlineServicesPrompt />
      <UpdateNotifier noticeEnabled />
      <LicenseStatusPrompt />
      <AppShell
        activeSection={activeSection}
        developerMode={developerMode}
        productionMode={productionMode}
        onSectionChange={(section) => { void requestSectionChange(section); }}
      >
        <AppRouter
          activeSection={activeSection}
          developerMode={developerMode}
          productionMode={productionMode}
          onDeveloperModeChange={setDeveloperMode}
          onSectionChange={(section) => { void requestSectionChange(section); }}
          registerLeaveGuard={(guard) => {
            leaveGuardRef.current = guard;
          }}
        />
      </AppShell>
    </>
  );
}

export default App;
