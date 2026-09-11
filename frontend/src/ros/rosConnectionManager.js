/**
 * Singleton rosbridge connection
 */
import ROSLIB from 'roslib';

class RosConnectionManager {
  constructor() {
    this.ros = null;
    this.connecting = false;
    this.url = '';
    this.connectionPromise = null;
  }

  async getConnection(rosbridgeUrl) {
    if (this.url !== rosbridgeUrl) {
      this.disconnect();
      this.url = rosbridgeUrl;
    }
    if (this.ros && this.ros.isConnected) return this.ros;
    if (this.connecting && this.connectionPromise) return this.connectionPromise;

    this.connecting = true;
    this.connectionPromise = new Promise((resolve, reject) => {
      const ros = new ROSLIB.Ros({ url: rosbridgeUrl });
      const timeout = setTimeout(() => {
        this.connecting = false;
        this.connectionPromise = null;
        reject(new Error('ROS connection timeout'));
      }, 10000);

      ros.on('connection', () => {
        clearTimeout(timeout);
        this.ros = ros;
        this.connecting = false;
        this.connectionPromise = null;
        resolve(ros);
      });
      ros.on('error', (err) => {
        clearTimeout(timeout);
        this.connecting = false;
        this.connectionPromise = null;
        this.ros = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      ros.on('close', () => {
        this.ros = null;
        this.connecting = false;
        this.connectionPromise = null;
      });
    });
    return this.connectionPromise;
  }

  disconnect() {
    if (this.ros) {
      this.ros.close();
      this.ros = null;
    }
    this.connecting = false;
    this.connectionPromise = null;
    this.url = '';
  }

  isConnected() {
    return !!(this.ros && this.ros.isConnected);
  }
}

const rosConnectionManager = new RosConnectionManager();
export default rosConnectionManager;
