import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';

/**
 * Poll /api/robot/readiness and expose home()/stow() actions.
 *
 * readiness shape: { server_ok, homed, stowed, stow_offenders, arm_pos, dongle_connected,
 *                    gamepad_running, runstop_engaged, runstop_cause,
 *                    battery_soc, charging, plugged_in, low_battery,
 *                    reading_age, busy: 'home'|'stow'|null, action_error, error }
 *
 */
export function useRobotReadiness({ enabled = true, intervalMs = 2000 } = {}) {
  const [readiness, setReadiness] = useState(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    try {
      const r = await api('/api/robot/readiness');
      setReadiness(r);
      return r;
    } catch {
      return undefined; // keep last known snapshot on transient errors
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    refresh();
    const t = setInterval(refresh, intervalMs);
    return () => clearInterval(t);
  }, [enabled, intervalMs, refresh]);

  const home = useCallback(async () => {
    await api('/api/robot/home', { method: 'POST', body: '{}' });
    await refresh();
  }, [refresh]);

  const stow = useCallback(async () => {
    await api('/api/robot/stow', { method: 'POST', body: '{}' });
    await refresh();
  }, [refresh]);

  return { readiness, refresh, home, stow };
}
