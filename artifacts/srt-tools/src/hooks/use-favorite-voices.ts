import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "favorite-voices";

function readFavorites(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === "string");
    return [];
  } catch {
    return [];
  }
}

function writeFavorites(next: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

let currentFavorites: string[] = readFavorites();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function setFavorites(next: string[]) {
  currentFavorites = next;
  writeFavorites(next);
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return currentFavorites;
}

function getServerSnapshot() {
  return currentFavorites;
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) {
      currentFavorites = readFavorites();
      emit();
    }
  });
}

export function useFavoriteVoices() {
  const favorites = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const isFavorite = useCallback(
    (shortName: string) => favorites.includes(shortName),
    [favorites],
  );

  const toggleFavorite = useCallback((shortName: string) => {
    const prev = currentFavorites;
    const next = prev.includes(shortName)
      ? prev.filter((x) => x !== shortName)
      : [...prev, shortName];
    setFavorites(next);
  }, []);

  const removeFavorite = useCallback((shortName: string) => {
    const prev = currentFavorites;
    if (!prev.includes(shortName)) return;
    setFavorites(prev.filter((x) => x !== shortName));
  }, []);

  return { favorites, isFavorite, toggleFavorite, removeFavorite };
}
