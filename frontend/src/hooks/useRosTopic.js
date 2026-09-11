import { useEffect, useRef, useState } from 'react';
import ROSLIB from 'roslib';
import rosConnectionManager from '../ros/rosConnectionManager';

/**
 * Subscribe to a ROS topic via the shared rosbridge connection.
 *
 * QoS note :
 * roslib 1.4.1 and the rosbridge protocol do NOT let the client pick a QoS
 * profile. rosbridge chooses the subscription QoS by inspecting the publishers
 * that exist *at the moment we subscribe*. Under rmw_zenoh the ROS graph can
 * lag, so if we subscribe before the freshly-launched publisher is discovered,
 * rosbridge locks in VOLATILE + BEST_EFFORT and never recovers. That silently
 * drops:
 *   - latched (TRANSIENT_LOCAL) topics published once, e.g. /robot_description
 *     and /tf_static, and
 *   - topics whose publisher only appears a moment later, e.g. /tf and
 *     /scan_filtered right after Mapping starts.
 * (/map still shows because slam_toolbox re-publishes it continuously.)
 *
 * Fix: re-subscribe on silence. If no message arrives within `resubscribeMs`,
 * tear the subscription down and recreate it so rosbridge re-negotiates QoS
 * against the now-present publisher. We stop as soon as data flows, or after
 * `maxResubscribes` attempts so topics with no publisher in the current mode
 * (e.g. /amcl_pose while mapping) do not churn forever.
 *
 * @returns {{ data, connected, error }}
 */
export function useRosTopic(
  rosbridgeUrl,
  topic,
  messageType,
  // serverThrottleMs asks rosbridge to drop messages before they cross the
  // network — essential for heavy topics like camera frames, where client-side
  // throttleMs would still pull every frame over WiFi just to ignore it.
  {
    enabled = true,
    throttleMs = 0,
    serverThrottleMs = 0,
    resubscribeMs = 4000,
    maxResubscribes = 12,
    // 'cbor' for anything big
    compression = 'none',
  } = {}
) {
  const [data, setData] = useState(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const lastEmit = useRef(0);

  useEffect(() => {
    if (!enabled || !rosbridgeUrl || !topic || !messageType) return undefined;
    let cancelled = false;
    let topicHandle = null;
    let rosHandle = null;
    let closeHandler = null;
    let retryTimer = null;
    let attempts = 0;
    let gotMessage = false;

    const clearRetry = () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const dropTopic = () => {
      if (topicHandle) {
        try {
          topicHandle.unsubscribe();
        } catch {
          /* ignore */
        }
        topicHandle = null;
      }
    };

    const dropRosListener = () => {
      if (rosHandle && closeHandler) {
        try {
          if (typeof rosHandle.off === 'function') {
            rosHandle.off('close', closeHandler);
          } else if (typeof rosHandle.removeListener === 'function') {
            rosHandle.removeListener('close', closeHandler);
          }
        } catch {
          /* ignore */
        }
      }
      rosHandle = null;
      closeHandler = null;
    };

    const scheduleRetry = () => {
      clearRetry();
      if (gotMessage || attempts >= maxResubscribes) return;
      retryTimer = setTimeout(() => {
        if (cancelled || gotMessage) return;
        attempts += 1;
        dropTopic();
        dropRosListener();
        // Recreate the subscription so rosbridge re-runs QoS negotiation.
        subscribe();
      }, resubscribeMs);
    };

    const subscribe = async () => {
      try {
        const ros = await rosConnectionManager.getConnection(rosbridgeUrl);
        if (cancelled) return;
        setConnected(true);
        setError(null);

        rosHandle = ros;
        closeHandler = () => {
          if (cancelled) return;
          setConnected(false);
          setError('ROS connection closed');
          gotMessage = false;
          attempts = 0;
          dropTopic();
          dropRosListener();
          scheduleRetry();
        };
        ros.on('close', closeHandler);

        const t = new ROSLIB.Topic({
          ros,
          name: topic,
          messageType,
          compression,
          ...(serverThrottleMs > 0 ? { throttle_rate: serverThrottleMs, queue_length: 1 } : {}),
        });
        topicHandle = t;
        t.subscribe((msg) => {
          gotMessage = true;
          clearRetry();
          if (throttleMs > 0) {
            const now = Date.now();
            if (now - lastEmit.current < throttleMs) return;
            lastEmit.current = now;
          }
          setData(msg);
        });

        scheduleRetry();
      } catch (err) {
        if (cancelled) return;
        setConnected(false);
        setError(err.message || String(err));
        scheduleRetry();
      }
    };

    subscribe();

    return () => {
      cancelled = true;
      clearRetry();
      dropTopic();
      dropRosListener();
    };
  }, [
    rosbridgeUrl,
    topic,
    messageType,
    enabled,
    throttleMs,
    serverThrottleMs,
    resubscribeMs,
    maxResubscribes,
    compression,
  ]);

  // Drop the last message when the subscription is switched off.
  useEffect(() => {
    if (!enabled) setData(null);
  }, [enabled]);

  return { data, connected, error };
}

export async function publishRos(rosbridgeUrl, topic, messageType, message) {
  const ros = await rosConnectionManager.getConnection(rosbridgeUrl);
  const t = new ROSLIB.Topic({ ros, name: topic, messageType });
  t.advertise();
  t.publish(new ROSLIB.Message(message));
  setTimeout(() => t.unadvertise(), 500);
}
