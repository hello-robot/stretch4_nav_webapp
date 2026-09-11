import { useEffect, useState } from 'react';
import * as THREE from 'three';
import URDFLoader from 'urdf-loader';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { api } from '../api';

/**
 * Load Stretch URDF XML, rewrite mesh URLs, return THREE URDFRobot.
 */
export function useUrdfRobot(urdfXml, enabled = true) {
  const [robot, setRobot] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !urdfXml) {
      setRobot(null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const meshBase = `${window.location.origin}/api/robot/meshes`;
        const rewritten = await api('/api/robot/rewrite-urdf', {
          method: 'POST',
          body: JSON.stringify({ urdf: urdfXml, mesh_base_url: meshBase }),
        });
        const xml = rewritten.urdf || urdfXml;

        const manager = new THREE.LoadingManager();
        const loader = new URDFLoader(manager);
        loader.packages = {
          stretch4_urdf: `${meshBase}/stretch4_urdf`,
          stretch_description: `${meshBase}/stretch_description`,
          stretch_core: `${meshBase}/stretch_core`,
        };
        // urdf-loader 0.13.x calls this with (path, manager, material, onComplete).
        // The 3rd arg is the URDF <material>, the 4th is the completion callback.
        loader.loadMeshCb = (path, loadManager, material, done) => {
          let url = path;
          if (!/^https?:/i.test(path) && !path.startsWith('/')) {
            url = `${meshBase}/${path.replace(/^\/+/, '')}`;
          } else if (path.startsWith('/api/')) {
            url = `${window.location.origin}${path}`;
          }
          const finish = (mesh, err) => {
            if (err) {
              console.warn('Mesh load failed', url, err);
              done(new THREE.Mesh(
                new THREE.BoxGeometry(0.04, 0.04, 0.04),
                new THREE.MeshBasicMaterial({ color: 0x666666 })
              ));
              return;
            }
            done(mesh);
          };
          if (/\.stl$/i.test(url.split('?')[0])) {
            new STLLoader(loadManager).load(
              url,
              (geom) => {
                geom.computeVertexNormals();
                // Prefer the URDF-declared material (RViz-like colors); fall back to gray.
                const mat = material || new THREE.MeshPhongMaterial({
                  color: 0xb8c0c8,
                  flatShading: false,
                });
                finish(new THREE.Mesh(geom, mat));
              },
              undefined,
              (err) => finish(null, err)
            );
          } else {
            finish(new THREE.Mesh(
              new THREE.BoxGeometry(0.05, 0.05, 0.05),
              new THREE.MeshBasicMaterial({ color: 0x888888 })
            ));
          }
        };

        const result = loader.parse(xml);
        if (cancelled) return;
        // Keep ROS Z-up; our MapViewer scene is Z-up.
        result.rotation.set(0, 0, 0);
        setRobot(result);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err.message || String(err));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [urdfXml, enabled]);

  return { robot, error, loading };
}

export function applyJointStates(robot, jointStates) {
  if (!robot || !jointStates?.name || !jointStates?.position) return;
  const names = jointStates.name;
  const positions = jointStates.position;
  for (let i = 0; i < names.length; i++) {
    const joint = robot.joints?.[names[i]];
    if (joint && typeof joint.setJointValue === 'function') {
      try {
        joint.setJointValue(positions[i]);
      } catch {
        // ignore unknown joint types
      }
    }
  }
}
