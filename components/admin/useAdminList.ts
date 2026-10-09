"use client";

import { useCallback, useEffect, useState } from "react";

export interface AdminListQuery {
  limit: number;
  offset: number;
  sortBy: string;
  sortDir: "asc" | "desc";
  dateFrom?: string;
  dateTo?: string;
  status?: string;
  userIdContains?: string;
}

export type AdminListResult<Row> =
  | { success: true; data: { rows: Row[]; total: number } }
  | { success: false; error: string };

export interface AdminFilterDraft {
  dateFrom: string;
  dateTo: string;
  status: string;
  userId: string;
}

const EMPTY_DRAFT: AdminFilterDraft = {
  dateFrom: "",
  dateTo: "",
  status: "",
  userId: "",
};

export interface UseAdminListReturn<Row> {
  rows: Row[];
  total: number | null;
  loading: boolean;
  error: string | null;
  page: number;
  pageSize: number;
  sortBy: string;
  sortDir: "asc" | "desc";
  draft: AdminFilterDraft;
  setDraft: React.Dispatch<React.SetStateAction<AdminFilterDraft>>;
  setSortBy: (v: string) => void;
  setSortDir: (v: "asc" | "desc") => void;
  setPageSize: (v: number) => void;
  setPage: React.Dispatch<React.SetStateAction<number>>;
  applyFilters: () => void;
  resetFilters: () => void;
  reload: () => void;
}

/**
 * Generic state container for a filterable, paginated admin list. One instance
 * per admin tab (cashouts, onramps, swaps). Mirrors the inline draft/applied
 * pattern the Trade Orders tab uses, but factored out so each new list does not
 * need its own ~15 useState declarations.
 *
 * `fetcher` must be a stable reference (a module-level server action), since it
 * participates in the fetch effect's dependency list.
 */
export function useAdminList<Row>(
  fetcher: (q: AdminListQuery) => Promise<AdminListResult<Row>>,
  options: { active: boolean; defaultSortBy?: string }
): UseAdminListReturn<Row> {
  const { active, defaultSortBy = "created_at" } = options;

  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [sortBy, setSortBy] = useState(defaultSortBy);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [draft, setDraft] = useState<AdminFilterDraft>(EMPTY_DRAFT);
  const [applied, setApplied] = useState<AdminFilterDraft>(EMPTY_DRAFT);
  const [nonce, setNonce] = useState(0);

  const fetchList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetcher({
        limit: pageSize,
        offset: page * pageSize,
        sortBy,
        sortDir,
        dateFrom: applied.dateFrom.trim() || undefined,
        dateTo: applied.dateTo.trim() || undefined,
        status: applied.status.trim() || undefined,
        userIdContains: applied.userId.trim() || undefined,
      });
      if (res.success) {
        setRows(res.data.rows);
        setTotal(res.data.total);
      } else {
        setError(res.error || "Failed to load");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [fetcher, page, pageSize, sortBy, sortDir, applied]);

  useEffect(() => {
    if (!active) return;
    void fetchList();
  }, [active, fetchList, nonce]);

  const applyFilters = useCallback(() => {
    setApplied(draft);
    setPage(0);
    setNonce((n) => n + 1);
  }, [draft]);

  const resetFilters = useCallback(() => {
    setDraft(EMPTY_DRAFT);
    setApplied(EMPTY_DRAFT);
    setPage(0);
    setNonce((n) => n + 1);
  }, []);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return {
    rows,
    total,
    loading,
    error,
    page,
    pageSize,
    sortBy,
    sortDir,
    draft,
    setDraft,
    setSortBy,
    setSortDir,
    setPageSize,
    setPage,
    applyFilters,
    resetFilters,
    reload,
  };
}
