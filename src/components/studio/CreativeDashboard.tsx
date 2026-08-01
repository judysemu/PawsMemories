import React from "react";

export interface DashboardMetric {
  label: string;
  value: React.ReactNode;
  tone?: "neutral" | "active" | "success" | "danger";
}

interface CreativeDashboardProps {
  title: string;
  subtitle?: string;
  metrics: DashboardMetric[];
  left: React.ReactNode;
  center: React.ReactNode;
  right: React.ReactNode;
  bottom?: React.ReactNode;
}

const metricTone: Record<NonNullable<DashboardMetric["tone"]>, string> = {
  neutral: "border-outline-variant/30 bg-surface-container-low text-on-surface",
  active: "border-primary/35 bg-primary/10 text-primary",
  success: "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  danger: "border-error/35 bg-error/10 text-error",
};

export function CreativeDashboard({ title, subtitle, metrics, left, center, right, bottom }: CreativeDashboardProps) {
  return (
    <section
      data-creative-dashboard="true"
      className="h-[calc(100dvh-4rem)] w-full overflow-hidden bg-background p-2 text-on-background sm:p-3"
    >
      <div className="mx-auto grid h-full max-w-[1720px] min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-2">
        <header className="grid shrink-0 gap-2 xl:grid-cols-[minmax(220px,1fr)_minmax(0,2fr)]">
          <div className="min-w-0 rounded-2xl border border-outline-variant/25 bg-surface/90 px-4 py-2 shadow-sm">
            <h1 className="truncate text-base font-black sm:text-lg">{title}</h1>
            {subtitle && <p className="truncate text-[11px] text-on-surface-variant sm:text-xs">{subtitle}</p>}
          </div>
          <dl className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4">
            {metrics.map((metric) => (
              <div key={metric.label} className={`min-w-0 rounded-2xl border px-3 py-2 ${metricTone[metric.tone || "neutral"]}`}>
                <dt className="truncate text-[9px] font-black uppercase tracking-[0.14em] opacity-65">{metric.label}</dt>
                <dd className="truncate text-sm font-black">{metric.value}</dd>
              </div>
            ))}
          </dl>
        </header>

        <div className="grid min-h-0 gap-2 lg:grid-cols-[280px_minmax(0,1fr)_300px] xl:grid-cols-[300px_minmax(0,1fr)_330px]">
          <aside data-dashboard-region="left" className="min-h-0 overflow-y-auto rounded-2xl border border-outline-variant/25 bg-surface/90 p-3 shadow-sm [scrollbar-width:thin]">
            {left}
          </aside>
          <main data-dashboard-region="center" className="relative min-h-0 overflow-hidden rounded-2xl border border-outline-variant/25 bg-surface-container-lowest shadow-sm">
            {center}
          </main>
          <aside data-dashboard-region="right" className="min-h-0 overflow-y-auto rounded-2xl border border-outline-variant/25 bg-surface/90 p-3 shadow-sm [scrollbar-width:thin]">
            {right}
          </aside>
        </div>

        {bottom && (
          <footer data-dashboard-region="bottom" className="shrink-0 overflow-hidden rounded-2xl border border-outline-variant/25 bg-surface/95 shadow-sm">
            {bottom}
          </footer>
        )}
      </div>
    </section>
  );
}

export default CreativeDashboard;
