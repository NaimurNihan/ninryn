import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronDown, Search, Mic, Check, Sparkles, Loader2, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useFavoriteVoices } from "@/hooks/use-favorite-voices";

export type EdgeVoice = {
  Name: string;
  ShortName: string;
  Gender: string;
  Locale: string;
  FriendlyName: string;
  Status: string;
};

type VoicePickerProps = {
  selectedVoice: string | null;
  onSelect: (voice: string | null) => void;
};

const localeDisplay = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" });
  } catch {
    return null;
  }
})();

const regionDisplay = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return null;
  }
})();

function safeDisplay(
  display: Intl.DisplayNames | null,
  code: string,
): string | null {
  if (!display) return null;
  try {
    const result = display.of(code);
    return result && result !== code ? result : null;
  } catch {
    return null;
  }
}

function getLocaleLabel(locale: string): string {
  const [lang, region] = locale.split("-");
  const langName = (lang && safeDisplay(localeDisplay, lang)) || lang || locale;
  if (region) {
    const regionName = safeDisplay(regionDisplay, region.toUpperCase());
    if (regionName) return `${langName} (${regionName})`;
    return `${langName} (${region})`;
  }
  return langName;
}

function getVoiceShortName(voice: EdgeVoice): string {
  const parts = voice.ShortName.split("-");
  const last = parts[parts.length - 1] || voice.ShortName;
  return last.replace(/Neural$/, "").replace(/Multilingual$/, " (Multi)");
}

export function VoicePicker({ selectedVoice, onSelect }: VoicePickerProps) {
  const [voices, setVoices] = useState<EdgeVoice[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeLocale, setActiveLocale] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const { favorites, isFavorite, toggleFavorite } = useFavoriteVoices();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`${import.meta.env.BASE_URL}api/tts/voices`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        setVoices(data.voices || []);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error(err);
        setError("Could not load voices");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const grouped = useMemo(() => {
    if (!voices) return [];
    const map = new Map<string, EdgeVoice[]>();
    for (const v of voices) {
      const list = map.get(v.Locale);
      if (list) list.push(v);
      else map.set(v.Locale, [v]);
    }
    const arr = Array.from(map.entries()).map(([locale, vs]) => ({
      locale,
      label: getLocaleLabel(locale),
      voices: [...vs].sort((a, b) =>
        getVoiceShortName(a).localeCompare(getVoiceShortName(b)),
      ),
    }));
    arr.sort((a, b) => a.label.localeCompare(b.label));
    return arr;
  }, [voices]);

  const filteredLocales = useMemo(() => {
    if (!search.trim()) return grouped;
    const q = search.trim().toLowerCase();
    return grouped.filter(
      (g) => g.label.toLowerCase().includes(q) || g.locale.toLowerCase().includes(q),
    );
  }, [grouped, search]);

  const activeGroup = useMemo(
    () => (activeLocale ? grouped.find((g) => g.locale === activeLocale) ?? null : null),
    [grouped, activeLocale],
  );

  const filteredVoices = useMemo(() => {
    if (!activeGroup) return [];
    if (!search.trim()) return activeGroup.voices;
    const q = search.trim().toLowerCase();
    return activeGroup.voices.filter(
      (v) =>
        v.ShortName.toLowerCase().includes(q) ||
        getVoiceShortName(v).toLowerCase().includes(q) ||
        v.Gender.toLowerCase().includes(q),
    );
  }, [activeGroup, search]);

  const favoriteVoices = useMemo(() => {
    if (!voices) return [];
    const set = new Set(favorites);
    return voices.filter((v) => set.has(v.ShortName));
  }, [voices, favorites]);

  const filteredFavorites = useMemo(() => {
    if (!search.trim()) return favoriteVoices;
    const q = search.trim().toLowerCase();
    return favoriteVoices.filter(
      (v) =>
        v.ShortName.toLowerCase().includes(q) ||
        getVoiceShortName(v).toLowerCase().includes(q) ||
        getLocaleLabel(v.Locale).toLowerCase().includes(q),
    );
  }, [favoriteVoices, search]);

  const selectedMeta = useMemo(() => {
    if (!selectedVoice || !voices) return null;
    const v = voices.find((x) => x.ShortName === selectedVoice);
    if (!v) return null;
    return { voice: v, label: getLocaleLabel(v.Locale), short: getVoiceShortName(v) };
  }, [selectedVoice, voices]);

  const triggerLabel = selectedMeta
    ? `${selectedMeta.label} · ${selectedMeta.short}`
    : "Auto-detect voice";

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setActiveLocale(null);
      setSearch("");
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-9 gap-2 max-w-[260px] truncate"
          data-testid="button-voice-picker"
        >
          <Mic className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="truncate text-xs font-medium">{triggerLabel}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[340px] p-0 overflow-hidden"
        align="end"
        sideOffset={6}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b">
          {activeGroup ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={() => {
                setActiveLocale(null);
                setSearch("");
              }}
              data-testid="button-back-languages"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          ) : (
            <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          )}
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={activeGroup ? `Search voices in ${activeGroup.label}` : "Search language…"}
            className="h-8 border-none shadow-none focus-visible:ring-0 px-0"
            data-testid="input-voice-search"
          />
        </div>

        <ScrollArea className="h-[340px]">
          {loading ? (
            <div className="flex items-center justify-center h-[340px] text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Loading voices…
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-[340px] text-sm text-destructive">
              {error}
            </div>
          ) : activeGroup ? (
            <div className="p-1">
              {filteredVoices.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No voices found
                </div>
              ) : (
                filteredVoices.map((v) => {
                  const isSelected = selectedVoice === v.ShortName;
                  const fav = isFavorite(v.ShortName);
                  return (
                    <div
                      key={v.ShortName}
                      className={`group w-full flex items-center gap-1 px-2.5 py-2 rounded-md text-left text-sm hover:bg-accent transition-colors ${
                        isSelected ? "bg-accent" : ""
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onSelect(v.ShortName);
                          handleOpenChange(false);
                        }}
                        className="flex-1 min-w-0 flex items-center gap-2 text-left"
                        data-testid={`voice-option-${v.ShortName}`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{getVoiceShortName(v)}</div>
                          <div className="text-[11px] text-muted-foreground truncate">
                            {v.Gender} · {v.ShortName}
                          </div>
                        </div>
                        {isSelected && <Check className="h-4 w-4 text-primary shrink-0" />}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite(v.ShortName);
                        }}
                        className={`shrink-0 h-7 w-7 rounded-md flex items-center justify-center hover:bg-background/80 transition-colors ${
                          fav ? "text-amber-500" : "text-muted-foreground/50 opacity-0 group-hover:opacity-100"
                        }`}
                        title={fav ? "Remove from favorites" : "Add to favorites"}
                        aria-label={fav ? "Remove from favorites" : "Add to favorites"}
                        data-testid={`button-favorite-${v.ShortName}`}
                      >
                        <Star
                          strokeWidth={fav ? 1.5 : 2}
                          className={`h-4 w-4 ${fav ? "fill-amber-400" : ""}`}
                        />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          ) : (
            <div className="p-1">
              {!search.trim() && (
                <button
                  type="button"
                  onClick={() => {
                    onSelect(null);
                    handleOpenChange(false);
                  }}
                  className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-left text-sm hover:bg-accent transition-colors mb-1 ${
                    selectedVoice === null ? "bg-accent" : ""
                  }`}
                  data-testid="voice-option-auto"
                >
                  <Sparkles className="h-4 w-4 text-primary shrink-0" />
                  <div className="flex-1">
                    <div className="font-medium">Auto-detect</div>
                    <div className="text-[11px] text-muted-foreground">
                      Pick voice based on text language
                    </div>
                  </div>
                  {selectedVoice === null && <Check className="h-4 w-4 text-primary shrink-0" />}
                </button>
              )}

              {filteredFavorites.length > 0 && (
                <div className="mb-1">
                  <div className="px-2.5 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Star strokeWidth={1.5} className="h-3 w-3 fill-amber-400 text-amber-500" />
                    Favorites
                  </div>
                  {filteredFavorites.map((v) => {
                    const isSelected = selectedVoice === v.ShortName;
                    return (
                      <div
                        key={`fav-${v.ShortName}`}
                        className={`group w-full flex items-center gap-1 px-2.5 py-2 rounded-md text-left text-sm hover:bg-accent transition-colors ${
                          isSelected ? "bg-accent" : ""
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            onSelect(v.ShortName);
                            handleOpenChange(false);
                          }}
                          className="flex-1 min-w-0 flex items-center gap-2 text-left"
                          data-testid={`favorite-quick-${v.ShortName}`}
                        >
                          <div className="flex-1 min-w-0">
                            <div className="font-medium truncate">{getVoiceShortName(v)}</div>
                            <div className="text-[11px] text-muted-foreground truncate">
                              {getLocaleLabel(v.Locale)} · {v.Gender}
                            </div>
                          </div>
                          {isSelected && <Check className="h-4 w-4 text-primary shrink-0" />}
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleFavorite(v.ShortName);
                          }}
                          className="shrink-0 h-7 w-7 rounded-md flex items-center justify-center hover:bg-background/80 text-amber-500"
                          title="Remove from favorites"
                          aria-label="Remove from favorites"
                          data-testid={`button-unfavorite-${v.ShortName}`}
                        >
                          <Star strokeWidth={1.5} className="h-4 w-4 fill-amber-400" />
                        </button>
                      </div>
                    );
                  })}
                  <div className="my-1 border-t border-border/60 mx-2" />
                </div>
              )}

              {filteredLocales.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No languages found
                </div>
              ) : (
                filteredLocales.map((g) => (
                  <button
                    key={g.locale}
                    type="button"
                    onClick={() => {
                      setActiveLocale(g.locale);
                      setSearch("");
                    }}
                    className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-left text-sm hover:bg-accent transition-colors"
                    data-testid={`language-option-${g.locale}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{g.label}</div>
                      <div className="text-[11px] text-muted-foreground">{g.locale}</div>
                    </div>
                    <Badge
                      variant="secondary"
                      className="font-mono text-[10px] h-5 px-1.5 shrink-0"
                    >
                      {g.voices.length}
                    </Badge>
                    <ChevronDown className="h-3.5 w-3.5 -rotate-90 opacity-50 shrink-0" />
                  </button>
                ))
              )}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
