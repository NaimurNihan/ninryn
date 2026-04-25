import { useEffect, useMemo, useState } from "react";
import { Star, Check, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useFavoriteVoices } from "@/hooks/use-favorite-voices";
import type { EdgeVoice } from "./voice-picker";

type FavoriteVoicesButtonProps = {
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

function safeDisplay(d: Intl.DisplayNames | null, code: string): string | null {
  if (!d) return null;
  try {
    const r = d.of(code);
    return r && r !== code ? r : null;
  } catch {
    return null;
  }
}

function getLocaleLabel(locale: string): string {
  const [lang, region] = locale.split("-");
  const langName = (lang && safeDisplay(localeDisplay, lang)) || lang || locale;
  if (region) {
    const regionName = safeDisplay(regionDisplay, region.toUpperCase());
    return regionName ? `${langName} (${regionName})` : `${langName} (${region})`;
  }
  return langName;
}

function getVoiceShortName(v: EdgeVoice): string {
  const parts = v.ShortName.split("-");
  const last = parts[parts.length - 1] || v.ShortName;
  return last.replace(/Neural$/, "").replace(/Multilingual$/, " (Multi)");
}

export function FavoriteVoicesButton({ selectedVoice, onSelect }: FavoriteVoicesButtonProps) {
  const [voices, setVoices] = useState<EdgeVoice[] | null>(null);
  const [open, setOpen] = useState(false);
  const { favorites, removeFavorite } = useFavoriteVoices();

  useEffect(() => {
    let cancelled = false;
    fetch(`${import.meta.env.BASE_URL}api/tts/voices`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (!cancelled) setVoices(data.voices || []);
      })
      .catch(() => {
        // silent — picker shows the error already
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const favoriteList = useMemo(() => {
    if (!voices) return [];
    const set = new Set(favorites);
    return voices.filter((v) => set.has(v.ShortName));
  }, [voices, favorites]);

  const count = favorites.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9 relative"
          title="Favorite voices"
          aria-label="Favorite voices"
          data-testid="button-favorite-voices"
        >
          <Star
            strokeWidth={count > 0 ? 1.5 : 2}
            className={`h-4 w-4 ${count > 0 ? "fill-amber-400 text-amber-500" : "text-muted-foreground"}`}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0 overflow-hidden" align="end" sideOffset={6}>
        <div className="px-3 py-2 border-b flex items-center gap-2">
          <Star strokeWidth={1.5} className="h-3.5 w-3.5 fill-amber-400 text-amber-500" />
          <span className="text-sm font-semibold">Favorite voices</span>
          {count > 0 && (
            <span className="ml-auto text-[11px] text-muted-foreground">{count} saved</span>
          )}
        </div>

        <ScrollArea className="max-h-[320px]">
          {favoriteList.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <Sparkles className="h-5 w-5 mx-auto mb-2 text-muted-foreground/60" />
              <div className="text-sm text-muted-foreground">No favorite voices yet</div>
              <div className="text-[11px] text-muted-foreground/80 mt-1">
                Open the voice picker and tap the star icon next to any voice to save it here.
              </div>
            </div>
          ) : (
            <div className="p-1">
              {favoriteList.map((v) => {
                const isSelected = selectedVoice === v.ShortName;
                return (
                  <div
                    key={v.ShortName}
                    className={`group w-full flex items-center gap-1 px-2.5 py-2 rounded-md text-sm hover:bg-accent transition-colors ${
                      isSelected ? "bg-accent" : ""
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(v.ShortName);
                        setOpen(false);
                      }}
                      className="flex-1 min-w-0 flex items-center gap-2 text-left"
                      data-testid={`favorite-pick-${v.ShortName}`}
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
                        removeFavorite(v.ShortName);
                      }}
                      className="shrink-0 h-7 w-7 rounded-md flex items-center justify-center hover:bg-background/80 text-amber-500"
                      title="Remove from favorites"
                      aria-label="Remove from favorites"
                      data-testid={`button-remove-favorite-${v.ShortName}`}
                    >
                      <Star className="h-4 w-4 fill-current" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
