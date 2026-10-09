"use client";

import type { UseAdminListReturn } from "./useAdminList";

export interface AdminSelectOption {
  value: string;
  label: string;
}

interface AdminListToolbarProps {
  list: UseAdminListReturn<unknown>;
  statusOptions: AdminSelectOption[];
  sortOptions: AdminSelectOption[];
  /** Label for the `status` filter slot. The unified transactions feed reuses
   *  this slot as a transaction-type filter, so it overrides the default. */
  filterLabel?: string;
}

const inputClass =
  "px-2 py-1.5 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500";

export function AdminListToolbar({
  list,
  statusOptions,
  sortOptions,
  filterLabel = "Status",
}: AdminListToolbarProps) {
  return (
    <div className="p-4 border-b border-[var(--ex-border)] space-y-3 bg-[var(--ex-surface-muted)]">
      <div className="flex flex-wrap gap-3 items-end">
        <label className="flex flex-col gap-1 text-xs text-[var(--ex-text-muted)]">
          From (UTC)
          <input
            type="date"
            value={list.draft.dateFrom}
            onChange={(e) =>
              list.setDraft((d) => ({ ...d, dateFrom: e.target.value }))
            }
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--ex-text-muted)]">
          To (UTC)
          <input
            type="date"
            value={list.draft.dateTo}
            onChange={(e) =>
              list.setDraft((d) => ({ ...d, dateTo: e.target.value }))
            }
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--ex-text-muted)]">
          {filterLabel}
          <select
            value={list.draft.status}
            onChange={(e) =>
              list.setDraft((d) => ({ ...d, status: e.target.value }))
            }
            className={`${inputClass} min-w-[10rem]`}
          >
            {statusOptions.map((o) => (
              <option key={o.value || "all"} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--ex-text-muted)] flex-1 min-w-[12rem]">
          User ID / email contains
          <input
            type="text"
            placeholder="Substring match"
            value={list.draft.userId}
            onChange={(e) =>
              list.setDraft((d) => ({ ...d, userId: e.target.value }))
            }
            className={`${inputClass} placeholder-[var(--ex-text-subtle)]`}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-3 items-end">
        <label className="flex flex-col gap-1 text-xs text-[var(--ex-text-muted)]">
          Sort by
          <select
            value={list.sortBy}
            onChange={(e) => {
              list.setSortBy(e.target.value);
              list.setPage(0);
            }}
            className={`${inputClass} min-w-[10rem]`}
          >
            {sortOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--ex-text-muted)]">
          Direction
          <select
            value={list.sortDir}
            onChange={(e) => {
              list.setSortDir(e.target.value as "asc" | "desc");
              list.setPage(0);
            }}
            className={inputClass}
          >
            <option value="desc">Newest first</option>
            <option value="asc">Oldest first</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--ex-text-muted)]">
          Page size
          <select
            value={list.pageSize}
            onChange={(e) => {
              list.setPageSize(Number(e.target.value));
              list.setPage(0);
            }}
            className={inputClass}
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </label>
        <button
          type="button"
          onClick={list.applyFilters}
          className="cursor-pointer px-4 py-2 bg-sky-500 hover:bg-sky-300 text-white text-sm font-medium rounded-md transition-colors"
        >
          Apply filters
        </button>
        <button
          type="button"
          onClick={list.resetFilters}
          className="cursor-pointer px-4 py-2 bg-[var(--ex-surface-muted)] hover:bg-slate-200 border-2 border-sky-500 text-[var(--ex-text)] text-sm font-medium rounded-md transition-colors"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

export function AdminListPagination({
  list,
}: {
  list: UseAdminListReturn<unknown>;
}) {
  if (list.total === null || list.total <= 0 || list.loading) return null;
  const { page, pageSize, total } = list;
  return (
    <div className="p-4 border-t border-[var(--ex-border)] flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--ex-text-muted)]">
      <span>
        Showing{" "}
        <span className="text-[var(--ex-text)]">
          {page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)}
        </span>{" "}
        of <span className="text-[var(--ex-text)]">{total}</span>
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={page <= 0}
          onClick={() => list.setPage((p) => Math.max(0, p - 1))}
          className="px-3 py-1.5 rounded-md bg-[var(--ex-surface-muted)] border border-[var(--ex-border)] text-[var(--ex-text)] disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-200 transition-colors"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={(page + 1) * pageSize >= total}
          onClick={() => list.setPage((p) => p + 1)}
          className="px-3 py-1.5 rounded-md bg-[var(--ex-surface-muted)] border border-[var(--ex-border)] text-[var(--ex-text)] disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-200 transition-colors"
        >
          Next
        </button>
      </div>
    </div>
  );
}
