import { GoogleLib } from "@/lib/googlelib";
import { useCallback, useEffect, useState } from "react";

export function useGoogleTimeslots(eventTypeId?: string) {
  const [availableGoogleSlots, setAvailableGoogleSlots] = useState<Date[]>([]);
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [error, setError] = useState<Error | null>(null);
  const [status, setStatus] = useState<
    "idle" | "pending" | "success" | "error"
  >("idle");
  // Bumped by reset() to re-run the fetch effect below.
  const [retryCount, setRetryCount] = useState(0);
  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
    // Actually retry. Clearing the error only closed the dialog and left the
    // picker idle with no slots — there was no way back short of a reload.
    setRetryCount((count) => count + 1);
  }, []);

  useEffect(() => {
    try {
      setStatus("pending");
      GoogleLib.google.script.run
        .withSuccessHandler(function ({
          timeslots,
          durationMinutes,
        }: {
          timeslots: string[];
          durationMinutes: number;
        }) {
          setAvailableGoogleSlots(
            timeslots.map((timeslot) => new Date(timeslot))
          );
          setDurationMinutes(durationMinutes);
          setStatus("success");
        })
        .withFailureHandler(function (err: Error) {
          setStatus("error");
          setError(err);
        })
        .fetchAvailability(eventTypeId);
    } catch (error) {
      console.error(error);
      setStatus("error");
      setError(error as Error);
    }
  }, [eventTypeId, retryCount]);

  return [availableGoogleSlots, durationMinutes, status, error, reset] as const;
}
