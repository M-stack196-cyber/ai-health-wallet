import { useCallback, useEffect, useRef, useState } from "react";
import { adminMessage, type AdminPage } from "@health-wallet/api";
import type { Notice } from "./ui";

/** Filters, keyset paging and loading state shared by the list screens. Only the newest request may update the screen. */
export function useList<F, T>(
  fetchPage: (filters: F, cursor: string | undefined) => Promise<AdminPage<T>>,
  none: F,
) {
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const [draft, setDraft] = useState<F>(none),
    [applied, setApplied] = useState<F>(none),
    [cursors, setCursors] = useState<(string | undefined)[]>([undefined]),
    [reloads, setReloads] = useState(0),
    [rows, setRows] = useState<T[]>([]),
    [next, setNext] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [notice, setNotice] = useState<Notice>();
  const request = useRef(0);
  useEffect(() => {
    const mine = ++request.current;
    setLoading(true);
    setNotice(undefined);
    fetchRef
      .current(applied, cursors[cursors.length - 1])
      .then((page) => {
        if (mine !== request.current) return;
        setRows(page.items);
        setNext(page.nextCursor);
      })
      .catch((error) => {
        if (mine !== request.current) return;
        setRows([]);
        setNext(null);
        setNotice({ kind: "error", text: adminMessage(error) });
      })
      .finally(() => {
        if (mine === request.current) setLoading(false);
      });
  }, [applied, cursors, reloads]);
  return {
    draft,
    setDraft,
    rows,
    setRows,
    next,
    loading,
    notice,
    setNotice,
    page: cursors.length,
    apply(filters: F) {
      setApplied(filters);
      setCursors([undefined]);
    },
    reset() {
      setDraft(none);
      setApplied(none);
      setCursors([undefined]);
    },
    previous: () => setCursors((c) => c.slice(0, -1)),
    forward: () => next && setCursors((c) => [...c, next]),
    reload: () => setReloads((n) => n + 1),
  };
}

/** One-off load (summary counts, health report) with a refresh button. */
export function useLoaded<T>(load: () => Promise<T>) {
  const loadRef = useRef(load);
  loadRef.current = load;
  const [value, setValue] = useState<T>(),
    [notice, setNotice] = useState<Notice>(),
    [loading, setLoading] = useState(true);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++request.current;
    setLoading(true);
    try {
      const result = await loadRef.current();
      if (mine !== request.current) return;
      setValue(result);
      setNotice(undefined);
    } catch (error) {
      if (mine === request.current) setNotice({ kind: "error", text: adminMessage(error) });
    } finally {
      if (mine === request.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { value, notice, loading, refresh };
}
