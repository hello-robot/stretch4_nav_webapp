import { useCallback, useMemo, useState } from 'react';
import { api } from '../api';

/**
 * Runstop control, held once in App so the topbar Stop button, the warning
 * banner and the status panel all show the same in-flight state.
 */
export function useRunstop({ readiness, refresh, onError }) {
  const [pending, setPending] = useState(null); // 'engage' | 'release' | null

  const engaged = readiness?.runstop_engaged ?? null;

  const send = useCallback(
    async (want) => {
      setPending(want ? 'engage' : 'release');
      try {
        await api('/api/robot/runstop', {
          method: 'POST',
          body: JSON.stringify({ engaged: want }),
        });
        await refresh?.();
      } catch (err) {
        onError?.(err.message);
      } finally {
        setPending(null);
      }
    },
    [refresh, onError]
  );

  const engage = useCallback(() => send(true), [send]);
  const release = useCallback(() => send(false), [send]);

  
  return useMemo(
    () => ({ engaged, pending, engage, release }),
    [engaged, pending, engage, release]
  );
}
