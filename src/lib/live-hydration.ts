/** Retry a snapshot invalidated by live events at most twice. Never apply an
 * older response over newer events, or keep refetching throughout a busy turn.
 * A later reconnect/focus or settled bot event can request a fresh snapshot. */
export async function hydrateLiveSnapshot<T>(options: {
  read: () => Promise<T>;
  revision: () => number;
  current: () => boolean;
  apply: (snapshot: T) => void;
}): Promise<boolean> {
  for (let attempt = 0; attempt < 3 && options.current(); attempt++) {
    const revision = options.revision();
    const snapshot = await options.read();
    if (!options.current()) return false;
    if (revision !== options.revision()) continue;
    options.apply(snapshot);
    return true;
  }
  return false;
}
