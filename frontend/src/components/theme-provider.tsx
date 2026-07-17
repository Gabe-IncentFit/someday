import { createContext, useContext, useEffect, useState } from "react";

type Theme = "dark" | "light" | "system";

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
  /** Pins the theme and ignores stored preference, for hosts that embed us. */
  forcedTheme?: Theme;
};

// Storage access is not guaranteed: a cross-origin iframe with third-party
// storage blocked (Safari's default) throws on touching localStorage rather
// than returning null, which would take the whole app down at mount.
function readStoredTheme(storageKey: string): Theme | null {
  try {
    return localStorage.getItem(storageKey) as Theme | null;
  } catch {
    return null;
  }
}

function writeStoredTheme(storageKey: string, theme: Theme) {
  try {
    localStorage.setItem(storageKey, theme);
  } catch {
    // Preference just won't persist; not worth failing the interaction over.
  }
}

type ThemeProviderState = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

const initialState: ThemeProviderState = {
  theme: "system",
  setTheme: () => null,
};

const ThemeProviderContext = createContext<ThemeProviderState>(initialState);

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "vite-ui-theme",
  forcedTheme,
  ...props
}: ThemeProviderProps) {
  const [storedTheme, setStoredTheme] = useState<Theme>(
    () => readStoredTheme(storageKey) || defaultTheme
  );
  const theme = forcedTheme ?? storedTheme;
  const setTheme = setStoredTheme;

  useEffect(() => {
    const root = window.document.documentElement;

    root.classList.remove("light", "dark");

    if (theme === "system") {
      const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
        .matches
        ? "dark"
        : "light";

      // Apply the current system theme immediately so a dark-mode OS doesn't get
      // a light first paint. (This previously sat after the cleanup return below,
      // so it was dead code and the class only got set once the OS theme changed.)
      root.classList.add(systemTheme);

      const handleSystemThemeChange = (e: MediaQueryListEvent) => {
        const newSystemTheme = e.matches ? "dark" : "light";
        root.classList.remove("light", "dark");
        root.classList.add(newSystemTheme);
      };

      window
        .matchMedia("(prefers-color-scheme: dark)")
        .addEventListener("change", handleSystemThemeChange);

      return () => {
        window
          .matchMedia("(prefers-color-scheme: dark)")
          .removeEventListener("change", handleSystemThemeChange);
      };
    }

    root.classList.add(theme);
  }, [theme]);

  const value = {
    theme,
    setTheme: (theme: Theme) => {
      writeStoredTheme(storageKey, theme);
      setTheme(theme);
    },
  };

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);

  if (context === undefined)
    throw new Error("useTheme must be used within a ThemeProvider");

  return context;
};
