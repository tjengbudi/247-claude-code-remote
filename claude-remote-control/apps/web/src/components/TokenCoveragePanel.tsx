'use client';

import { useState, useEffect, useCallback } from 'react';
import { ShieldCheck, ShieldAlert, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CoverageData {
  status: 'covered' | 'tokenless' | 'empty';
  total: number;
  tokenless: number;
  covered: number;
  message: string;
}

export function TokenCoveragePanel() {
  const [data, setData] = useState<CoverageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCoverage = useCallback(async () => {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch('/api/token-coverage');
      if (!res.ok) {
        if (res.status === 401) {
          setError('You must be signed in to view token coverage.');
          return;
        }
        const body = await res.json().catch(() => null);
        setError(body?.message ?? 'Failed to load token coverage.');
        return;
      }
      const json = (await res.json()) as CoverageData;
      setData(json);
    } catch {
      setError('Could not reach the server. Check your connection.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCoverage();
  }, [fetchCoverage]);

  const statusConfig = {
    empty: {
      icon: ShieldCheck,
      color: 'text-emerald-400',
      bgColor: 'bg-emerald-500/10',
      borderColor: 'border-emerald-500/20',
      label: 'No connections yet',
    },
    covered: {
      icon: ShieldCheck,
      color: 'text-emerald-400',
      bgColor: 'bg-emerald-500/10',
      borderColor: 'border-emerald-500/20',
      label: 'All connections tokenized',
    },
    tokenless: {
      icon: ShieldAlert,
      color: 'text-amber-400',
      bgColor: 'bg-amber-500/10',
      borderColor: 'border-amber-500/20',
      label: 'Tokenless connections found',
    },
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-white/30" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/10 p-4">
          <AlertCircle className="h-5 w-5 shrink-0 text-red-400" />
          <p className="text-sm text-red-300">{error}</p>
        </div>
        <button
          onClick={fetchCoverage}
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-white/70 transition-colors hover:bg-white/5 hover:text-white"
        >
          <RefreshCw className="h-4 w-4" />
          Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  const config = statusConfig[data.status];
  const StatusIcon = config.icon;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <p className="text-sm text-white/60">
          Check whether every connection holds a token before enabling enforcement.
        </p>
      </div>

      {/* Status card */}
      <div
        className={cn(
          'rounded-xl border p-4',
          config.bgColor,
          config.borderColor,
        )}
      >
        <div className="flex items-start gap-3">
          <StatusIcon className={cn('h-5 w-5 shrink-0', config.color)} />
          <div className="space-y-1">
            <h3 className={cn('font-medium', config.color)}>{config.label}</h3>
            <p className="text-sm text-white/60">{data.message}</p>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-center">
          <div className="text-lg font-semibold text-white">{data.total}</div>
          <div className="text-xs text-white/40">Total</div>
        </div>
        <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-center">
          <div className="text-lg font-semibold text-emerald-400">{data.covered}</div>
          <div className="text-xs text-white/40">Covered</div>
        </div>
        <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-center">
          <div
            className={cn(
              'text-lg font-semibold',
              data.tokenless > 0 ? 'text-amber-400' : 'text-white/40',
            )}
          >
            {data.tokenless}
          </div>
          <div className="text-xs text-white/40">Tokenless</div>
        </div>
      </div>

      {/* Two-sided verification caveat */}
      <div className="rounded-xl bg-white/5 p-4 text-sm text-white/50">
        <p>
          <strong className="text-white/70">Presence ≠ correctness.</strong> This surface
          checks that each connection <em>holds</em> a token — it does NOT verify the token
          actually authenticates at the agent. Run{' '}
          <code className="rounded bg-white/10 px-1 py-0.5 text-white/70">
            247 token --test
          </code>{' '}
          for the reach check.
        </p>
      </div>

      {/* Refresh */}
      <button
        onClick={fetchCoverage}
        className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-white/70 transition-colors hover:bg-white/5 hover:text-white"
      >
        <RefreshCw className="h-4 w-4" />
        Refresh
      </button>
    </div>
  );
}
