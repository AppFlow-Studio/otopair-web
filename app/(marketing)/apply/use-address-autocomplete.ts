"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Google Places address autocomplete, mirroring the portal shop-setup flow
 * (app/(portal)/shop/setup/page.tsx) but packaged as a reusable hook for the
 * public /apply form. Uses the modern Places API (`AutocompleteSuggestion` +
 * session token) and lazy-loads the Maps JS SDK on first keystroke.
 *
 * Degrades gracefully: if the key is missing or the SDK fails to load, the
 * field stays a plain text input (no suggestions, no error thrown at the user).
 */

type GoogleAutocompleteSuggestion = {
  placePrediction?: {
    text?: { toString(): string };
    secondaryText?: { toString(): string };
    toPlace?: () => {
      fetchFields?: (request: { fields: string[] }) => Promise<void>;
      formattedAddress?: string;
    };
  };
};

type GoogleMapsWindow = Window & {
  google?: {
    maps?: {
      importLibrary?: (library: string) => Promise<unknown>;
    };
  };
  __googleMapsApiPromise?: Promise<void>;
};

export type AddressSuggestion = {
  id: string;
  primaryText: string;
  secondaryText: string;
  suggestion: GoogleAutocompleteSuggestion;
};

// Idempotent loader — shares the same global promise + script guard the shop
// setup page uses, so both surfaces reuse a single Maps SDK load per page.
async function loadGoogleMapsPlacesApi(): Promise<void> {
  const mapsWindow = window as GoogleMapsWindow;
  if (mapsWindow.google?.maps?.importLibrary) return;
  if (!mapsWindow.__googleMapsApiPromise) {
    mapsWindow.__googleMapsApiPromise = new Promise<void>((resolve, reject) => {
      const existing = document.querySelector(
        'script[data-google-maps-api="true"]',
      ) as HTMLScriptElement | null;
      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error("Failed to load Google Maps.")), {
          once: true,
        });
        return;
      }
      const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
      if (!apiKey) {
        reject(new Error("Missing NEXT_PUBLIC_GOOGLE_MAPS_API_KEY."));
        return;
      }
      const script = document.createElement("script");
      script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&loading=async&libraries=places&v=weekly`;
      script.async = true;
      script.defer = true;
      script.dataset.googleMapsApi = "true";
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Failed to load Google Maps."));
      document.head.appendChild(script);
    });
  }
  await mapsWindow.__googleMapsApiPromise;
}

export function useAddressAutocomplete(onSelect: (address: string) => void) {
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const sessionRef = useRef<unknown>(null);
  const reqIdRef = useRef(0);
  const timeoutRef = useRef<number | undefined>(undefined);
  // Keep the latest callback without re-creating the memoized helpers.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const clear = useCallback(() => {
    window.clearTimeout(timeoutRef.current);
    setSuggestions([]);
    setLoading(false);
    setHighlight(-1);
  }, []);

  const search = useCallback((raw: string) => {
    window.clearTimeout(timeoutRef.current);
    const query = raw.trim();
    setHighlight(-1);
    if (!query) {
      setSuggestions([]);
      setLoading(false);
      return;
    }
    timeoutRef.current = window.setTimeout(async () => {
      const requestId = ++reqIdRef.current;
      setLoading(true);
      try {
        await loadGoogleMapsPlacesApi();
        const maps = (window as GoogleMapsWindow).google?.maps;
        if (!maps?.importLibrary) return;

        const places = (await maps.importLibrary("places")) as {
          AutocompleteSuggestion?: {
            fetchAutocompleteSuggestions?: (
              request: Record<string, unknown>,
            ) => Promise<{ suggestions?: GoogleAutocompleteSuggestion[] }>;
          };
          AutocompleteSessionToken?: new () => unknown;
        };

        if (!sessionRef.current && places.AutocompleteSessionToken) {
          sessionRef.current = new places.AutocompleteSessionToken();
        }

        const response = await places.AutocompleteSuggestion?.fetchAutocompleteSuggestions?.({
          input: query,
          includedRegionCodes: ["us"],
          sessionToken: sessionRef.current ?? undefined,
        });

        if (reqIdRef.current !== requestId) return;

        const next = (response?.suggestions ?? [])
          .slice(0, 5)
          .map((suggestion, i) => ({
            id: `${query}-${i}`,
            primaryText: suggestion.placePrediction?.text?.toString() ?? "",
            secondaryText: suggestion.placePrediction?.secondaryText?.toString() ?? "",
            suggestion,
          }))
          .filter((entry) => entry.primaryText);
        setSuggestions(next);
      } catch {
        if (reqIdRef.current === requestId) setSuggestions([]);
      } finally {
        if (reqIdRef.current === requestId) setLoading(false);
      }
    }, 250);
  }, []);

  const choose = useCallback(
    async (entry: AddressSuggestion) => {
      clear();
      const fallback = [entry.primaryText, entry.secondaryText].filter(Boolean).join(", ");
      const place = entry.suggestion.placePrediction?.toPlace?.();
      if (!place?.fetchFields) {
        onSelectRef.current(fallback);
        return;
      }
      try {
        await place.fetchFields({ fields: ["formattedAddress"] });
        sessionRef.current = null; // end the billing session after a resolved pick
        const formatted = (place.formattedAddress || fallback).replace(/,\s*USA$/, "");
        onSelectRef.current(formatted);
      } catch {
        onSelectRef.current(fallback);
      }
    },
    [clear],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (suggestions.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((i) => (i < 0 ? 0 : (i + 1) % suggestions.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
      } else if (e.key === "Enter") {
        // Dropdown open → Enter picks a suggestion, never submits the form.
        e.preventDefault();
        void choose(suggestions[highlight >= 0 ? highlight : 0]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        clear();
      }
    },
    [suggestions, highlight, choose, clear],
  );

  return { suggestions, loading, highlight, setHighlight, search, clear, choose, handleKeyDown };
}
