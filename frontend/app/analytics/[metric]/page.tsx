"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Card } from "../../../src/components/ui/Card";
import { getAnalyticsMetric, isUnauthorized, type AnalyticsMetricPoint } from "../../../src/lib/api";
import { getToken } from "../../../src/lib/auth";
import { formatRub } from "../../../src/lib/format";

type MetricKey = "balance" | "remaining" | "debts" | "daily-total";

const METRIC_CONFIG: Record<MetricKey, { title: string }> = {
  balance: { title: "История баланса" },
  remaining: { title: "История остатка" },
  debts: { title: "История долгов" },
  "daily-total": { title: "История итогов за день" },
};

const ACTIVE_BUDGET_STORAGE_KEY = "mf_active_budget_id";

const formatAxisDate = (value: string): string => {
  const date = new Date(`${value}T00:00:00`);
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
};

function LineChart({ points }: { points: AnalyticsMetricPoint[] }) {
  const { polyline, marks, min, max } = useMemo(() => {
    if (!points.length) {
      return { polyline: "", marks: [], min: 0, max: 0 };
    }
    const values = points.map((point) => point.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = Math.max(max - min, 1);
    const width = 100;
    const height = 40;
    const polyline = points
      .map((point, index) => {
        const x = points.length === 1 ? 0 : (index / (points.length - 1)) * width;
        const y = height - ((point.value - min) / range) * height;
        return `${x},${y}`;
      })
      .join(" ");
    const marks = [points[0], points[Math.floor((points.length - 1) / 2)], points[points.length - 1]].filter(Boolean);
    return { polyline, marks, min, max };
  }, [points]);

  if (!points.length) {
    return <p className="mf-muted">Данные отсутствуют.</p>;
  }

  return (
    <div className="mf-stack">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="mf-analytics-chart" role="img" aria-label="График аналитики за 30 дней">
        <polyline points={polyline} fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <div className="mf-row" style={{ justifyContent: "space-between" }}>
        {marks.map((point) => (
          <span key={point.date} className="mf-small">
            {formatAxisDate(point.date)} · {formatRub(point.value)}
          </span>
        ))}
      </div>
      <div className="mf-row" style={{ justifyContent: "space-between" }}>
        <span className="mf-small">Мин: {formatRub(min)}</span>
        <span className="mf-small">Макс: {formatRub(max)}</span>
      </div>
    </div>
  );
}

export default function AnalyticsMetricPage({ params }: { params: { metric: string } }) {
  const metric = params.metric as MetricKey;
  const metricConfig = METRIC_CONFIG[metric];
  const [points, setPoints] = useState<AnalyticsMetricPoint[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!metricConfig) {
      setError("Метрика не найдена");
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const token = getToken();
        const budgetId = window.localStorage.getItem(ACTIVE_BUDGET_STORAGE_KEY);
        if (!token || !budgetId) {
          setError("Не выбраны сессия или бюджет");
          return;
        }
        const data = await getAnalyticsMetric(token, budgetId, metric, 30);
        if (!cancelled) {
          setPoints(data);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          if (isUnauthorized(loadError)) {
            setError("Сессия истекла");
            return;
          }
          setError("Не удалось загрузить аналитику");
        }
      }
    };

    void load();
    const interval = window.setInterval(() => {
      void load();
    }, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [metric, metricConfig]);

  if (!metricConfig) {
    return (
      <main className="mf-page">
        <p>Метрика не поддерживается.</p>
      </main>
    );
  }

  return (
    <main className="mf-page">
      <div className="mf-shell">
        <div className="mf-row" style={{ justifyContent: "space-between" }}>
          <h2 className="mf-card__title">{metricConfig.title}</h2>
          <Link href="/" className="mf-link-button">← К странице «День»</Link>
        </div>
        <Card>
          {error ? <p>{error}</p> : <LineChart points={points} />}
        </Card>
      </div>
    </main>
  );
}
