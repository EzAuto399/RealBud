export const EVENT_STREAM_RETRY_DELAYS_MS = [250, 750, 1_500, 3_000, 5_000] as const;
export const EVENT_STREAM_WATCHDOG_MS = 12_000;

export interface ResilientEventStreamOptions {
  getSessionToken: (force: boolean) => Promise<string>;
  onMessage: (event: MessageEvent) => void;
  onOpen: () => void;
  onError: () => void;
  createSource?: (url: string) => EventSource;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
  /** Set to 0 only in deterministic tests that exercise retry scheduling. */
  watchdogMs?: number;
}

/**
 * EventSource retries reuse the original URL. That is wrong for RealBud:
 * restarting the local harness rotates its short-lived session token, so the
 * browser's native retry can remain on 401 forever while ordinary API calls
 * have already recovered. Close the stale stream, refresh the token and open
 * a new stream with bounded backoff instead.
 */
export function openResilientEventStream(options: ResilientEventStreamOptions): () => void {
  const createSource = options.createSource ?? ((url: string) => new EventSource(url));
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelSchedule = options.cancelSchedule ?? ((timer) => clearTimeout(timer));

  let stopped = false;
  let source: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let retryIndex = 0;

  const clearWatchdog = () => {
    if (watchdogTimer !== null) cancelSchedule(watchdogTimer);
    watchdogTimer = null;
  };

  const resetWatchdog = () => {
    clearWatchdog();
    const watchdogMs = options.watchdogMs ?? EVENT_STREAM_WATCHDOG_MS;
    if (stopped || watchdogMs <= 0) return;
    watchdogTimer = schedule(() => {
      watchdogTimer = null;
      if (stopped || !source) return;
      const stale = source;
      source = null;
      stale.close();
      options.onError();
      queueReconnect();
    }, watchdogMs);
  };

  const queueReconnect = () => {
    if (stopped || reconnectTimer !== null) return;
    const delay = EVENT_STREAM_RETRY_DELAYS_MS[Math.min(retryIndex, EVENT_STREAM_RETRY_DELAYS_MS.length - 1)];
    retryIndex += 1;
    reconnectTimer = schedule(() => {
      reconnectTimer = null;
      void connect(true);
    }, delay);
  };

  const connect = async (forceToken: boolean) => {
    if (stopped) return;
    try {
      const token = await options.getSessionToken(forceToken);
      if (stopped) return;
      const next = createSource(token ? `/api/events?session=${encodeURIComponent(token)}` : "/api/events");
      source = next;
      next.onopen = () => {
        if (stopped || source !== next) return;
        retryIndex = 0;
        resetWatchdog();
        options.onOpen();
      };
      next.onmessage = (event) => {
        if (!stopped && source === next) {
          resetWatchdog();
          options.onMessage(event);
        }
      };
      next.onerror = () => {
        if (stopped || source !== next) return;
        source = null;
        clearWatchdog();
        next.close();
        options.onError();
        queueReconnect();
      };
      // A dev proxy can leave the request pending without ever producing an
      // EventSource error. Start the silence deadline while connecting too.
      resetWatchdog();
    } catch {
      if (stopped) return;
      options.onError();
      queueReconnect();
    }
  };

  void connect(false);

  return () => {
    stopped = true;
    source?.close();
    source = null;
    clearWatchdog();
    if (reconnectTimer !== null) cancelSchedule(reconnectTimer);
    reconnectTimer = null;
  };
}
