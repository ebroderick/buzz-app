import {
  isValidElement,
  useLayoutEffect,
  useMemo,
  type ReactElement,
} from "react";
import { ContributionBoundary } from "../conversation/ContributionBoundary";
import type { RegisteredSidebarRows, SidebarRow } from "./sidebar-rows-service";

export function SidebarRowRenderer({
  row,
  entries,
  children,
  onHiddenChange,
}: {
  row: SidebarRow;
  entries: readonly RegisteredSidebarRows[];
  children: ReactElement;
  onHiddenChange?: ((id: string, hidden: boolean) => void) | undefined;
}) {
  const resetIdentity = useMemo(() => [entries, row], [entries, row]);
  let result: ReactElement | null = children;
  try {
    for (const entry of entries) {
      if (!entry.render) continue;
      result = entry.render(row, result);
      if (result !== null && !isValidElement(result))
        throw new Error("Invalid sidebar row render result");
    }
  } catch {
    result = children;
  }
  const hidden = result === null;
  useLayoutEffect(() => {
    onHiddenChange?.(row.id, hidden);
    return () => onHiddenChange?.(row.id, false);
  }, [onHiddenChange, row.id, hidden]);
  return (
    <ContributionBoundary fallback={children} resetIdentity={resetIdentity}>
      {result}
    </ContributionBoundary>
  );
}
