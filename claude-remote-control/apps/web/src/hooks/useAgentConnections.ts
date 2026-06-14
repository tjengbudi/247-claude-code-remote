'use client';

import { useState, useEffect, useCallback } from 'react';

// Re-export the type with proper typing for method field
// This matches StoredAgentConnection in AgentConnectionSettings.tsx
export interface AgentConnection {
  id: string;
  url: string;
  name: string;
  method: 'localhost' | 'tailscale' | 'custom' | 'cloud';
  createdAt: number;
  isCloud?: boolean;
  cloudAgentId?: string;
  color?: string;
  token?: string;
}

export interface UseAgentConnectionsReturn {
  connections: AgentConnection[];
  loading: boolean;
  error: string | null;
  addConnection: (data: { url: string; name: string; method?: string; color?: string }) => Promise<AgentConnection>;
  removeConnection: (id: string) => Promise<void>;
  updateConnection: (
    id: string,
    data: { url?: string; name?: string; method?: string; color?: string }
  ) => Promise<AgentConnection>;
  refetch: () => Promise<void>;
}

const LOCAL_MODE = process.env.NEXT_PUBLIC_LOCAL_MODE === 'true';
const LOCAL_STORAGE_KEY = '247-local-connections';

function readLocalConnections(): AgentConnection[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AgentConnection[]) : [];
  } catch {
    return [];
  }
}

function writeLocalConnections(connections: AgentConnection[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(connections));
}

export function useAgentConnections(): UseAgentConnectionsReturn {
  const [connections, setConnections] = useState<AgentConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchConnections = useCallback(async () => {
    if (LOCAL_MODE) {
      setError(null);
      setConnections(readLocalConnections());
      setLoading(false);
      return;
    }
    try {
      setError(null);
      const res = await fetch('/api/connections');
      if (!res.ok) {
        if (res.status === 401) {
          // Not authenticated, middleware will handle redirect
          setLoading(false);
          return;
        }
        throw new Error('Failed to fetch connections');
      }
      const data = await res.json();
      // Convert DB format to AgentConnection format
      setConnections(
        data.map((c: Record<string, unknown>) => ({
          id: c.id as string,
          url: c.url as string,
          name: c.name as string,
          method: c.method as AgentConnection['method'],
          createdAt: c.createdAt ? new Date(c.createdAt as string).getTime() : Date.now(),
          isCloud: c.isCloud as boolean | undefined,
          cloudAgentId: c.cloudAgentId as string | undefined,
          color: c.color as string | undefined,
          token: c.token as string | undefined,
        }))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  const addConnection = async (data: {
    url: string;
    name: string;
    method?: string;
    color?: string;
  }): Promise<AgentConnection> => {
    if (LOCAL_MODE) {
      const connection: AgentConnection = {
        id: crypto.randomUUID(),
        url: data.url,
        name: data.name,
        method: (data.method as AgentConnection['method']) || 'localhost',
        createdAt: Date.now(),
        color: data.color,
      };
      setConnections((prev) => {
        const next = [...prev, connection];
        writeLocalConnections(next);
        return next;
      });
      return connection;
    }
    const res = await fetch('/api/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      throw new Error('Failed to create connection');
    }

    const raw = await res.json();
    const connection: AgentConnection = {
      id: raw.id,
      url: raw.url,
      name: raw.name,
      method: raw.method as AgentConnection['method'],
      createdAt: raw.createdAt ? new Date(raw.createdAt).getTime() : Date.now(),
      isCloud: raw.isCloud,
      cloudAgentId: raw.cloudAgentId,
      color: raw.color,
      token: raw.token,
    };
    setConnections((prev) => [...prev, connection]);
    return connection;
  };

  const removeConnection = async (id: string): Promise<void> => {
    if (LOCAL_MODE) {
      setConnections((prev) => {
        const next = prev.filter((c) => c.id !== id);
        writeLocalConnections(next);
        return next;
      });
      return;
    }
    const res = await fetch(`/api/connections/${id}`, { method: 'DELETE' });

    if (!res.ok) {
      throw new Error('Failed to delete connection');
    }

    setConnections((prev) => prev.filter((c) => c.id !== id));
  };

  const updateConnection = async (
    id: string,
    data: { url?: string; name?: string; method?: string; color?: string }
  ): Promise<AgentConnection> => {
    if (LOCAL_MODE) {
      let updated!: AgentConnection;
      setConnections((prev) => {
        const next = prev.map((c) => {
          if (c.id !== id) return c;
          updated = {
            ...c,
            url: data.url ?? c.url,
            name: data.name ?? c.name,
            method: (data.method as AgentConnection['method']) ?? c.method,
            color: data.color ?? c.color,
          };
          return updated;
        });
        writeLocalConnections(next);
        return next;
      });
      return updated;
    }
    const res = await fetch(`/api/connections/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      throw new Error('Failed to update connection');
    }

    const raw = await res.json();
    const connection: AgentConnection = {
      id: raw.id,
      url: raw.url,
      name: raw.name,
      method: raw.method as AgentConnection['method'],
      createdAt: raw.createdAt ? new Date(raw.createdAt).getTime() : Date.now(),
      isCloud: raw.isCloud,
      cloudAgentId: raw.cloudAgentId,
      color: raw.color,
      token: raw.token,
    };
    setConnections((prev) => prev.map((c) => (c.id === id ? connection : c)));
    return connection;
  };

  return {
    connections,
    loading,
    error,
    addConnection,
    removeConnection,
    updateConnection,
    refetch: fetchConnections,
  };
}
