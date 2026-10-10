import { useEffect, useState } from "react";

/**
 * Tracks a media query. Used to decide whether a column is a rail or a sheet:
 * keeping the sheet mounted at desktop widths leaves Base UI's exit animation
 * without an animationend event, so the dialog never unmounts and its inert
 * overlay swallows every click on the page.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}
