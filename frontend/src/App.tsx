import { useEffect, useState } from "react";
import { isDemoMode, isDev } from "@/clientEnv";
import { CalendarPicker } from "@/components/calendar-picker";
import { ThemeProvider } from "@/components/theme-provider";
import { DemoBanner } from "@/DemoBanner";
import { ConfigScreen } from "@/components/ConfigScreen";
import { Config, EventType } from "@/models/EventType";
import { EventTypeSelector } from "@/components/EventTypeSelector";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import "./App.css";
import "./index.css";

import { GoogleLib } from "@/lib/googlelib";

function LoadFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-4 p-6 text-center">
      <h2 className="text-lg font-semibold">Couldn't load the scheduler</h2>
      <p className="text-sm text-muted-foreground max-w-sm">{message}</p>
      <Button onClick={onRetry}>Try again</Button>
    </div>
  );
}

function App() {
  const [isOwner, setIsOwner] = useState(false);
  const [view, setView] = useState<"calendar" | "config" | "event-selector">("calendar");
  const [config, setConfig] = useState<Config | null>(null);
  const [selectedEventType, setSelectedEventType] = useState<EventType | null>(null);
  const [loading, setLoading] = useState(true);
  const [initError, setInitError] = useState<Error | null>(null);
  // Bumped by the retry button to re-run the init effect.
  const [retryCount, setRetryCount] = useState(0);

  const determineInitialView = (data: Config) => {
    const selectable = data.EVENT_TYPES.filter(et => et.selectable);
    if (selectable.length === 1) {
      setSelectedEventType(selectable[0]);
      setView("calendar");
    } else if (selectable.length > 1) {
      setView("event-selector");
    } else {
      // No selectable events? Show first one anyway or config?
      setSelectedEventType(data.EVENT_TYPES[0]);
      setView("calendar");
    }
  };

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      setInitError(null);
      try {
        let owner = false;
        let configData: Config | null = null;

        if (typeof google !== "undefined") {
          owner = await new Promise<boolean>((resolve, reject) => {
            GoogleLib.google.script.run.withSuccessHandler(resolve).withFailureHandler(reject).isOwner();
          });
          configData = await new Promise<Config>((resolve, reject) => {
            GoogleLib.google.script.run.withSuccessHandler(resolve).withFailureHandler(reject).getConfig();
          });
        } else if (isDev || isDemoMode) {
          // Demo builds have no Apps Script `google` global and isDev is false,
          // so without this they fell through with configData null — leaving the
          // same null eventType the guard below now rejects.
          owner = true;
          configData = {
            TIME_ZONE: "America/New_York",
            WORKDAYS: [1, 2, 3, 4, 5],
            WORKHOURS: { start: 9, end: 16 },
            MAX_DAYS_IN_ADVANCE: 28,
            EVENT_TYPES: [
              { id: "30min", name: "30 Minute Meeting", duration: 30, selectable: true },
              { id: "60min", name: "1 Hour Strategy", duration: 60, selectable: true },
              { id: "secret", name: "Secret Meeting", duration: 15, selectable: false },
            ],
            CALENDARS: ["primary"],
          };
        }

        setIsOwner(owner);
        setConfig(configData);

        let page: string | null = null;
        let eventTypeId: string | null = null;

        // @ts-expect-error: google object is provided by Apps Script at runtime
        if (typeof google !== "undefined" && google.script && google.script.url) {
          const location = await new Promise<any>((resolve) => {
            // @ts-expect-error: google object is provided by Apps Script at runtime
            google.script.url.getLocation(resolve);
          });
          page = location.parameter["page"];
          eventTypeId = location.parameter["event-type"];
        } else {
          const params = new URLSearchParams(window.location.search);
          page = params.get("page");
          eventTypeId = params.get("event-type");
        }

        if (page === "config" && owner) {
          setView("config");
        } else if (eventTypeId && configData) {
          const matched = configData.EVENT_TYPES.find(et => et.id === eventTypeId);
          if (matched) {
            setSelectedEventType(matched);
            setView("calendar");
          } else {
            // Fallback if not found
            determineInitialView(configData);
          }
        } else if (configData) {
          determineInitialView(configData);
        }
      } catch (err) {
        console.error("Failed to initialize app:", err);
        // Surface it. Swallowing this left config/selectedEventType null while
        // the view stayed on "calendar", so the picker still rendered and slots
        // still loaded (availability is a separate RPC that tolerates an
        // undefined event type). Everything looked fine until Send threw on
        // eventType.id inside an event handler — which React doesn't catch — so
        // the button just did nothing, permanently and with no feedback.
        setInitError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [retryCount]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const retryInit = () => setRetryCount((count) => count + 1);

  if (initError) {
    return (
      <ThemeProvider>
        <LoadFailure message={initError.message} onRetry={retryInit} />
      </ThemeProvider>
    );
  }

  const handleSelectEventType = (et: EventType) => {
    setSelectedEventType(et);
    setView("calendar");
  };

  const handleBackToSelector = () => {
    const selectable = config?.EVENT_TYPES.filter(et => et.selectable) || [];
    if (selectable.length > 1) {
      setView("event-selector");
      setSelectedEventType(null);
    }
  };

  return (
    <ThemeProvider>
      <DemoBanner show={isDemoMode} />
      <div className="relative">
        {view === "config" ? (
          <ConfigScreen onBack={() => {
            if (selectedEventType) setView("calendar");
            else if (config) determineInitialView(config);
          }} />
        ) : view === "event-selector" ? (
          <EventTypeSelector
            eventTypes={config?.EVENT_TYPES.filter(et => et.selectable) || []}
            onSelect={handleSelectEventType}
            onOpenConfig={isOwner ? () => setView("config") : undefined}
          />
        ) : selectedEventType ? (
          <CalendarPicker
            onOpenConfig={isOwner ? () => setView("config") : undefined}
            eventType={selectedEventType}
            onBack={config && config.EVENT_TYPES.filter(et => et.selectable).length > 1 ? handleBackToSelector : undefined}
          />
        ) : (
          // No usable event type: rendering the picker anyway (via
          // selectedEventType!) looked fine until Send threw on eventType.id.
          <LoadFailure
            message="No event type is available to book."
            onRetry={retryInit}
          />
        )}
      </div>
      <div className="font-mono pt-4 text-accent-foreground text-sm">
        made by <a href="https://github.com/rbbydotdev/someday">@rbbydotdev</a>{" "}
        👋
      </div>
    </ThemeProvider>
  );
}

export default App;
